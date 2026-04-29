// ============================================================
// HOOKKA ERP - Shared Mutable Mock Data Store
// Simulates database until PostgreSQL is connected
// Matches Google Sheet "Production Sheet" structure
// ============================================================

// NOTE: Types are canonically defined in @/types/index.ts.
// This file keeps its own type definitions for backward compatibility.
// New code should import types from "@/types" instead of "@/lib/mock-data".

// Re-export types that were extracted to @/types and removed from this file.
// This ensures backward compatibility for consumers importing from mock-data.
export type {
  Department, Customer, DeliveryHub, MaterialSubstitute,
  BOMComponent, DeptWorkingTime, Product, FabricItem, RawMaterial, Worker,
  ItemCategory,
  SOStatus, ProductionStatus, JobCardStatus, DeliveryStatus,
  AttendanceStatus, StockCategory,
} from "@/types";

import type {
  Department, Customer, MaterialSubstitute,
  DeptWorkingTime, Product, FabricItem, RawMaterial, Worker,
  ItemCategory,
  SOStatus, ProductionStatus, JobCardStatus, DeliveryStatus,
  AttendanceStatus,
  RMBatch, CostLedgerEntry, FGBatch,
} from "@/types";

// --- Helpers ---
let _idCounter = 1000;
export function generateId(): string {
  return `id-${Date.now()}-${(_idCounter++).toString(36)}`;
}

// --- Departments — 8 production + 4 non-production + R&D (per Working Hours revamp) ---
//   1-8   production (carry SOFA / BEDFRAME / ACCESSORY category in working_hour_entries)
//   9-12  non-production (no category): WAREHOUSING (借工), REPAIR (修货),
//         MAINTENANCE (维护), PRODUCTION_SHORTFALL (闲置)
//   13    R&D — non-production
//
// `isProduction` replaces the previously hardcoded PRODUCTION_DEPT_CODES set
// in the frontend so new depts added via the admin UI carry the right
// SOFA/BEDFRAME/ACCESSORY-category semantics without a code change.
export const departments: Department[] = [
  { id: "dept-1", code: "FAB_CUT", name: "Fabric Cutting", shortName: "Fab Cut", sequence: 1, color: "#3B82F6", workingHoursPerDay: 9, isProduction: true },
  { id: "dept-2", code: "FAB_SEW", name: "Fabric Sewing", shortName: "Fab Sew", sequence: 2, color: "#6366F1", workingHoursPerDay: 9, isProduction: true },
  { id: "dept-3", code: "WOOD_CUT", name: "Wood Cutting", shortName: "Wood Cut", sequence: 3, color: "#F59E0B", workingHoursPerDay: 9, isProduction: true },
  { id: "dept-4", code: "FOAM", name: "Foam Bonding", shortName: "Foam", sequence: 4, color: "#8B5CF6", workingHoursPerDay: 9, isProduction: true },
  { id: "dept-5", code: "FRAMING", name: "Framing", shortName: "Framing", sequence: 5, color: "#F97316", workingHoursPerDay: 9, isProduction: true },
  { id: "dept-6", code: "WEBBING", name: "Webbing", shortName: "Webbing", sequence: 6, color: "#10B981", workingHoursPerDay: 9, isProduction: true },
  { id: "dept-7", code: "UPHOLSTERY", name: "Upholstery", shortName: "Upholstery", sequence: 7, color: "#F43F5E", workingHoursPerDay: 9, isProduction: true },
  { id: "dept-8", code: "PACKING", name: "Packing", shortName: "Packing", sequence: 8, color: "#06B6D4", workingHoursPerDay: 9, isProduction: true },
  { id: "dept-9", code: "WAREHOUSING", name: "Warehousing", shortName: "Warehouse", sequence: 9, color: "#14B8A6", workingHoursPerDay: 9, isProduction: false },
  { id: "dept-10", code: "REPAIR", name: "Repair", shortName: "Repair", sequence: 10, color: "#EAB308", workingHoursPerDay: 9, isProduction: false },
  { id: "dept-11", code: "MAINTENANCE", name: "Maintenance", shortName: "Maint", sequence: 11, color: "#64748B", workingHoursPerDay: 9, isProduction: false },
  { id: "dept-12", code: "PRODUCTION_SHORTFALL", name: "Production Shortfall", shortName: "Shortfall", sequence: 12, color: "#DC2626", workingHoursPerDay: 9, isProduction: false },
  { id: "dept-13", code: "R_AND_D", name: "R&D", shortName: "R&D", sequence: 13, color: "#0EA5E9", workingHoursPerDay: 9, isProduction: false },
];

// --- Customers ---
export const customers: Customer[] = [
  {
    id: "cust-1", code: "300-H", name: "Houzs Century",
    ssmNo: "201901012345", companyAddress: "1831-B, JALAN KPB 1, KAWASAN PERINDUSTRIAN BALAKONG, 43300 SERI KEMBANGAN, SELANGOR.",
    creditTerms: "NET30", creditLimitSen: 100000000, outstandingSen: 26500000, isActive: true,
    contactName: "Purchasing", phone: "011-6151 1613", email: "operation@houzscentury.com",
    deliveryHubs: [
      { id: "hub-h1", code: "300-H001", shortName: "Houzs KL", state: "KL", address: "1831-B, JALAN KPB 1, KAWASAN PERINDUSTRIAN BALAKONG, SERI KEMBANGAN, SELANGOR.", contactName: "Purchasing", phone: "011-6151 1613", email: "operation@houzscentury.com", isDefault: true },
      { id: "hub-h2", code: "300-H002", shortName: "Houzs PG", state: "PG", address: "868, JALAN ESTATE, BARU, MUKIM 12, 14100 SIMPANG AMPAT, PULAU PINANG.", contactName: "Purchasing", phone: "011-6151 1613", email: "operation@houzscentury.com", isDefault: false },
      { id: "hub-h3", code: "300-H003", shortName: "Houzs SRW", state: "SRW", address: "1831-B, JALAN KPB 1, KAWASAN PERINDUSTRIAN BALAKONG, SERI KEMBANGAN, SELANGOR.", contactName: "Purchasing", phone: "011-6151 1613", email: "operation@houzscentury.com", isDefault: false },
      { id: "hub-h4", code: "300-H004", shortName: "Houzs SBH", state: "SBH", address: "1831-B, JALAN KPB 1, KAWASAN PERINDUSTRIAN BALAKONG, SERI KEMBANGAN, SELANGOR.", contactName: "Purchasing", phone: "011-6151 1613", email: "operation@houzscentury.com", isDefault: false },
    ],
  },
  {
    id: "cust-2", code: "300-C", name: "Carress",
    ssmNo: "201801054321", companyAddress: "LOT 35057, JLN PERMAI 3, TAMAN KLANG UTAMA, 42100 KLANG, SELANGOR",
    creditTerms: "NET30", creditLimitSen: 30000000, outstandingSen: 8200000, isActive: true,
    contactName: "Jess", phone: "017-226 1288", email: "",
    deliveryHubs: [
      { id: "hub-c1", code: "300-C001", shortName: "Carress KL", state: "KL", address: "LOT 35057, JLN PERMAI 3, TAMAN KLANG UTAMA, 42100 KLANG, SELANGOR", contactName: "Jess", phone: "017-226 1288", email: "", isDefault: true },
    ],
  },
  {
    id: "cust-3", code: "300-T", name: "The Conts",
    ssmNo: "202001098765", companyAddress: "1831-B, JALAN KPB 1, KAWASAN PERINDUSTRIAN BALAKONG, 43300 SERI KEMBANGAN, SELANGOR.",
    creditTerms: "NET30", creditLimitSen: 20000000, outstandingSen: 4100000, isActive: true,
    contactName: "Fong", phone: "016-794 0605", email: "",
    deliveryHubs: [
      { id: "hub-t1", code: "300-T001", shortName: "The Conts KL", state: "KL", address: "1831-B, JALAN KPB 1, KAWASAN PERINDUSTRIAN BALAKONG, SERI KEMBANGAN, SELANGOR.", contactName: "Fong", phone: "016-794 0605", email: "", isDefault: true },
    ],
  },
];

// --- Products (SKU definitions matching SKU SF / SKU BF sheets) ---

// Helper BOM builders
// Product-specific department working times from Google Sheet
const HILTON_DEPT_TIMES: DeptWorkingTime[] = [
  { departmentCode: "FAB_CUT", minutes: 40, category: "CAT 4" },
  { departmentCode: "FAB_SEW", minutes: 150, category: "CAT 2" },
  { departmentCode: "WOOD_CUT", minutes: 20, category: "CAT 3" },
  { departmentCode: "FOAM", minutes: 25, category: "CAT 3" },
  { departmentCode: "FRAMING", minutes: 40, category: "CAT 4" },
  { departmentCode: "WEBBING", minutes: 15, category: "CAT 3" },
  { departmentCode: "UPHOLSTERY", minutes: 40, category: "CAT 4" },
  { departmentCode: "PACKING", minutes: 15, category: "CAT 2" },
];

// Legacy constants kept for backward compatibility (unused but referenced nowhere else)
const BEDFRAME_DEPT_TIMES: DeptWorkingTime[] = HILTON_DEPT_TIMES;

// Seat height pricing tiers for sofa modules (in sen = RM * 100)
// Re-exported from @/lib/pricing-options so pages can import the constant
// without dragging in the full mock-data seed bundle.
export { SEAT_HEIGHT_OPTIONS } from "@/lib/pricing-options";

export const products: Product[] = [
  { id: "prod-1", code: "1003-(K)", name: "HILTON BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton bedframe king 6ft (183x190cm)", baseModel: "1003", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 68000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES, skuCode: "HL10-KHB-HIL03", fabricColor: "FG66151-1", pieces: { count: 3, names: ["HB", "Divan", "Legs"] } },
  { id: "prod-2", code: "1003-(Q)", name: "HILTON BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton bedframe queen 5ft (152x190cm)", baseModel: "1003", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 56000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-3", code: "1003-(S)", name: "HILTON BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton bedframe single 3ft (90x190cm)", baseModel: "1003", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 50000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-4", code: "1003-(SS)", name: "HILTON BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton bedframe super single 3.5ft (107x190cm)", baseModel: "1003", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 53000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-5", code: "1003(A)-(K)", name: "HILTON(A) BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe king 6ft (183x190cm)", baseModel: "1003(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 68000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-6", code: "1003(A)-(Q)", name: "HILTON(A) BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe queen 5ft (152x190cm)", baseModel: "1003(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 56000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-7", code: "1003(A)-(S)", name: "HILTON(A) BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe single 3ft (90x190cm)", baseModel: "1003(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 50000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-8", code: "1003(A)-(SS)", name: "HILTON(A) BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe super single 3.5ft (107x190cm)", baseModel: "1003(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 53000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-9", code: "1003(A)-(SK)", name: "HILTON(A) BEDFRAME (200X200CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe super king 200x200cm", baseModel: "1003(A)", sizeCode: "SK", sizeLabel: "200CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 112000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-10", code: "1003(A)-(SP)", name: "HILTON(A) BEDFRAME (220X220CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe super plus 220x220cm", baseModel: "1003(A)", sizeCode: "SP", sizeLabel: "220CMX220CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 123200, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-11", code: "1003(A)(HF)(W)-(K)", name: "HILTON(A) BEDFRAME (HF)(W) (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe (hf)(w) king 6ft (183x190cm)", baseModel: "1003(A)(HF)(W)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 68000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-12", code: "1003(A)(HF)(W)-(Q)", name: "HILTON(A) BEDFRAME (HF)(W) (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe (hf)(w) queen 5ft (152x190cm)", baseModel: "1003(A)(HF)(W)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 56000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-13", code: "1003(A)(HF)(W)-(S)", name: "HILTON(A) BEDFRAME (HF)(W) (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe (hf)(w) single 3ft (90x190cm)", baseModel: "1003(A)(HF)(W)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 50000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-14", code: "1003(A)(HF)(W)-(SS)", name: "HILTON(A) BEDFRAME (HF)(W) (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "hilton(a) bedframe (hf)(w) super single 3.5ft (107x190cm)", baseModel: "1003(A)(HF)(W)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 53000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-15", code: "1005-(K)", name: "FENRIR BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "fenrir bedframe king 6ft (183x190cm)", baseModel: "1005", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, price1Sen: 46000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-16", code: "1005-(Q)", name: "FENRIR BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "fenrir bedframe queen 5ft (152x190cm)", baseModel: "1005", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 40000, price1Sen: 34000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-17", code: "1005-(S)", name: "FENRIR BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "fenrir bedframe single 3ft (90x190cm)", baseModel: "1005", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 38000, price1Sen: 32000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-18", code: "1005-(SK)", name: "FENRIR BEDFRAME (200X200CM)", category: "BEDFRAME" as ItemCategory, description: "fenrir bedframe super king 200x200cm", baseModel: "1005", sizeCode: "SK", sizeLabel: "200CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 104000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-19", code: "1005-(SS)", name: "FENRIR BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "fenrir bedframe super single 3.5ft (107x190cm)", baseModel: "1005", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 39000, price1Sen: 33000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-20", code: "1007-(K)", name: "CODY BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe king 6ft (183x190cm)", baseModel: "1007", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-21", code: "1007-(Q)", name: "CODY BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe queen 5ft (152x190cm)", baseModel: "1007", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 40000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-22", code: "1007-(S)", name: "CODY BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe single 3ft (90x190cm)", baseModel: "1007", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 38000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-23", code: "1007-(SS)", name: "CODY BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe super single 3.5ft (107x190cm)", baseModel: "1007", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 39000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-24", code: "1007-(152X200)", name: "CODY BEDFRAME (152X200CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe 152x200cm", baseModel: "1007", sizeCode: "152X200", sizeLabel: "152CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-25", code: "1007-(183X200)", name: "CODY BEDFRAME (183X200CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe 183x200cm", baseModel: "1007", sizeCode: "183X200", sizeLabel: "183CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-26", code: "1007-(200X200)", name: "CODY BEDFRAME (200X200CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe 200x200cm", baseModel: "1007", sizeCode: "200X200", sizeLabel: "200CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 104000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-27", code: "1007(HF)(W)-(K)", name: "CODY BEDFRAME (HF)(W) (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe (hf)(w) king 6ft (183x190cm)", baseModel: "1007(HF)(W)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-28", code: "1007(HF)(W)-(Q)", name: "CODY BEDFRAME (HF)(W) (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe (hf)(w) queen 5ft (152x190cm)", baseModel: "1007(HF)(W)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 40000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-29", code: "1007(HF)(W)-(S)", name: "CODY BEDFRAME (HF)(W) (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe (hf)(w) single 3ft (90x190cm)", baseModel: "1007(HF)(W)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 38000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-30", code: "1007(HF)(W)-(SS)", name: "CODY BEDFRAME (HF)(W) (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "cody bedframe (hf)(w) super single 3.5ft (107x190cm)", baseModel: "1007(HF)(W)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 39000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-31", code: "1008-(K)", name: "RICARDO BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "ricardo bedframe king 6ft (183x190cm)", baseModel: "1008", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 50800, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-32", code: "1008-(Q)", name: "RICARDO BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "ricardo bedframe queen 5ft (152x190cm)", baseModel: "1008", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 37800, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-33", code: "1008-(S)", name: "RICARDO BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "ricardo bedframe single 3ft (90x190cm)", baseModel: "1008", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 32400, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-34", code: "1008-(SS)", name: "RICARDO BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "ricardo bedframe super single 3.5ft (107x190cm)", baseModel: "1008", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 33500, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-35", code: "1009(A)-(K)", name: "VALKRIE(A) BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "valkrie(a) bedframe king 6ft (183x190cm)", baseModel: "1009(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 50800, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-36", code: "1009(A)-(Q)", name: "VALKRIE(A) BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "valkrie(a) bedframe queen 5ft (152x190cm)", baseModel: "1009(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 37800, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-37", code: "1009(A)-(S)", name: "VALKRIE(A) BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "valkrie(a) bedframe single 3ft (90x190cm)", baseModel: "1009(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 38000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-38", code: "1009(A)-(SS)", name: "VALKRIE(A) BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "valkrie(a) bedframe super single 3.5ft (107x190cm)", baseModel: "1009(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 39000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-39", code: "1013-(K)", name: "JAGER BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "jager bedframe king 6ft (183x190cm)", baseModel: "1013", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 40000, price1Sen: 32000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-40", code: "1013-(Q)", name: "JAGER BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "jager bedframe queen 5ft (152x190cm)", baseModel: "1013", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 28000, price1Sen: 20000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES, skuCode: "JG13-QHB-JAG02", fabricColor: "FG66152-3", pieces: { count: 3, names: ["HB", "Divan", "Legs"] } },
  { id: "prod-41", code: "1013-(S)", name: "JAGER BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "jager bedframe single 3ft (90x190cm)", baseModel: "1013", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 26000, price1Sen: 18000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-42", code: "1013-(SS)", name: "JAGER BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "jager bedframe super single 3.5ft (107x190cm)", baseModel: "1013", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 27000, price1Sen: 19000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-43", code: "1013-(SK)", name: "JAGER BEDFRAME (200X200CM)", category: "BEDFRAME" as ItemCategory, description: "jager bedframe super king 200x200cm", baseModel: "1013", sizeCode: "SK", sizeLabel: "200CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-44", code: "1019(A)-(K)", name: "ARIZONA BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "arizona bedframe king 6ft (183x190cm)", baseModel: "1019(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 63000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-45", code: "1019(A)-(Q)", name: "ARIZONA BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "arizona bedframe queen 5ft (152x190cm)", baseModel: "1019(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 51000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-46", code: "1019(A)-(S)", name: "ARIZONA BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "arizona bedframe single 3ft (90x190cm)", baseModel: "1019(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 43000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-47", code: "1019(A)-(SS)", name: "ARIZONA BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "arizona bedframe super single 3.5ft (107x190cm)", baseModel: "1019(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 48000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-48", code: "1019(A)(HF)(W)-(K)", name: "ARIZONA BEDFRAME (HF)(W) (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "arizona bedframe (hf)(w) king 6ft (183x190cm)", baseModel: "1019(A)(HF)(W)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-49", code: "1019(A)(HF)(W)-(Q)", name: "ARIZONA BEDFRAME (HF)(W) (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "arizona bedframe (hf)(w) queen 5ft (152x190cm)", baseModel: "1019(A)(HF)(W)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 55000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-50", code: "1019(A)(HF)(W)-(S)", name: "ARIZONA BEDFRAME (HF)(W) (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "arizona bedframe (hf)(w) single 3ft (90x190cm)", baseModel: "1019(A)(HF)(W)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 47000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-51", code: "1019(A)(HF)(W)-(SS)", name: "ARIZONA BEDFRAME (HF)(W) (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "arizona bedframe (hf)(w) super single 3.5ft (107x190cm)", baseModel: "1019(A)(HF)(W)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-52", code: "1041-(K)", name: "VICTORIA BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "victoria bedframe king 6ft (183x190cm)", baseModel: "1041", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 49500, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-53", code: "1041-(Q)", name: "VICTORIA BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "victoria bedframe queen 5ft (152x190cm)", baseModel: "1041", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 37500, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-54", code: "1041-(S)", name: "VICTORIA BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "victoria bedframe single 3ft (90x190cm)", baseModel: "1041", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 35500, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-55", code: "1041-(SS)", name: "VICTORIA BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "victoria bedframe super single 3.5ft (107x190cm)", baseModel: "1041", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 36500, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-56", code: "1041-(SP)", name: "VICTORIA BEDFRAME (107X200CM)", category: "BEDFRAME" as ItemCategory, description: "victoria bedframe 107x200cm", baseModel: "1041", sizeCode: "SP", sizeLabel: "107CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 73000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-57", code: "1023-(K)", name: "COTY BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "coty bedframe king 6ft (183x190cm)", baseModel: "1023", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-58", code: "1023-(Q)", name: "COTY BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "coty bedframe queen 5ft (152x190cm)", baseModel: "1023", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 40000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-59", code: "1023-(S)", name: "COTY BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "coty bedframe single 3ft (90x190cm)", baseModel: "1023", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 38000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-60", code: "1023-(SS)", name: "COTY BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "coty bedframe super single 3.5ft (107x190cm)", baseModel: "1023", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 39000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-61", code: "1023(HF)(W)-(K)", name: "COTY BEDFRAME (HF)(W) (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "coty bedframe (hf)(w) king 6ft (183x190cm)", baseModel: "1023(HF)(W)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-62", code: "1023(HF)(W)-(Q)", name: "COTY BEDFRAME (HF)(W) (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "coty bedframe (hf)(w) queen 5ft (152x190cm)", baseModel: "1023(HF)(W)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 39000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-63", code: "1023(HF)(W)-(S)", name: "COTY BEDFRAME (HF)(W) (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "coty bedframe (hf)(w) single 3ft (90x190cm)", baseModel: "1023(HF)(W)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 38000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-64", code: "1023(HF)(W)-(SS)", name: "COTY BEDFRAME (HF)(W) (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "coty bedframe (hf)(w) super single 3.5ft (107x190cm)", baseModel: "1023(HF)(W)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 39000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-65", code: "1030-(K)", name: "TIFANNY BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "tifanny bedframe king 6ft (183x190cm)", baseModel: "1030", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-66", code: "1030-(Q)", name: "TIFANNY BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "tifanny bedframe queen 5ft (152x190cm)", baseModel: "1030", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 40000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-67", code: "1030-(S)", name: "TIFANNY BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "tifanny bedframe single 3ft (90x190cm)", baseModel: "1030", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 38000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-68", code: "1030-(SS)", name: "TIFANNY BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "tifanny bedframe super single 3.5ft (107x190cm)", baseModel: "1030", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 39000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-69", code: "1030(HF)(W)-(Q)", name: "TIFANNY BEDFRAME (HF)(W) (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "tifanny bedframe (hf)(w) queen 5ft (152x190cm)", baseModel: "1030(HF)(W)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 40000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-70", code: "1030(HF)(W)-(K)", name: "TIFANNY BEDFRAME (HF)(W) (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "tifanny bedframe (hf)(w) king 6ft (183x190cm)", baseModel: "1030(HF)(W)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-71", code: "2003-(K)", name: "ELEPHANE BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "elephane bedframe king 6ft (183x190cm)", baseModel: "2003", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 90000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-72", code: "2003-(Q)", name: "ELEPHANE BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "elephane bedframe queen 5ft (152x190cm)", baseModel: "2003", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-73", code: "2003-(S)", name: "ELEPHANE BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "elephane bedframe single 3ft (90x190cm)", baseModel: "2003", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 72000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-74", code: "2003-(SS)", name: "ELEPHANE BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "elephane bedframe super single 3.5ft (107x190cm)", baseModel: "2003", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 75000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-75", code: "2003-(SP)", name: "ELEPHANE BEDFRAME (183X200CM)", category: "BEDFRAME" as ItemCategory, description: "elephane bedframe 183x200cm", baseModel: "2003", sizeCode: "SP", sizeLabel: "183CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 180000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-76", code: "2006-(K)", name: "REGAL BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "regal bedframe king 6ft (183x190cm)", baseModel: "2006", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, price1Sen: 62000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-77", code: "2006-(Q)", name: "REGAL BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "regal bedframe queen 5ft (152x190cm)", baseModel: "2006", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 55000, price1Sen: 50000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-78", code: "2006-(S)", name: "REGAL BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "regal bedframe single 3ft (90x190cm)", baseModel: "2006", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 47000, price1Sen: 42000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-79", code: "2006-(SS)", name: "REGAL BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "regal bedframe super single 3.5ft (107x190cm)", baseModel: "2006", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, price1Sen: 47000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-80", code: "2006(A)-(K)", name: "REGAL(A) BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "regal(a) bedframe king 6ft (183x190cm)", baseModel: "2006(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, price1Sen: 62000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-81", code: "2006(A)-(Q)", name: "REGAL(A) BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "regal(a) bedframe queen 5ft (152x190cm)", baseModel: "2006(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 55000, price1Sen: 50000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-82", code: "2006(A)-(S)", name: "REGAL(A) BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "regal(a) bedframe single 3ft (90x190cm)", baseModel: "2006(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 47000, price1Sen: 42000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-83", code: "2006(A)-(SS)", name: "REGAL(A) BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "regal(a) bedframe super single 3.5ft (107x190cm)", baseModel: "2006(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 52000, price1Sen: 47000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-84", code: "2006(A)-(SK)", name: "REGAL(A) BEDFRAME (200X200CM)", category: "BEDFRAME" as ItemCategory, description: "regal(a) bedframe super king 200x200cm", baseModel: "2006(A)", sizeCode: "SK", sizeLabel: "200CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 160000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-85", code: "2008-(K)", name: "TRION (HB STRAIGHT) BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion (hb straight) bedframe king 6ft (183x190cm)", baseModel: "2008", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-86", code: "2008-(Q)", name: "TRION (HB STRAIGHT) BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion (hb straight) bedframe queen 5ft (152x190cm)", baseModel: "2008", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-87", code: "2008-(S)", name: "TRION (HB STRAIGHT) BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion (hb straight) bedframe single 3ft (90x190cm)", baseModel: "2008", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 64000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-88", code: "2008-(SS)", name: "TRION (HB STRAIGHT) BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion (hb straight) bedframe super single 3.5ft (107x190cm)", baseModel: "2008", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-89", code: "2008(A)-(K)", name: "TRION(A) (HB STRAIGHT) BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) (hb straight) bedframe king 6ft (183x190cm)", baseModel: "2008(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-90", code: "2008(A)-(Q)", name: "TRION(A) (HB STRAIGHT) BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) (hb straight) bedframe queen 5ft (152x190cm)", baseModel: "2008(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-91", code: "2008(A)-(S)", name: "TRION(A) (HB STRAIGHT) BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) (hb straight) bedframe single 3ft (90x190cm)", baseModel: "2008(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 64000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-92", code: "2008(A)-(SS)", name: "TRION(A) (HB STRAIGHT) BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) (hb straight) bedframe super single 3.5ft (107x190cm)", baseModel: "2008(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-93", code: "2008(A)-(SP)", name: "TRION(A) (HB STRAIGHT) BEDFRAME (183X200CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) (hb straight) bedframe 183x200cm", baseModel: "2008(A)", sizeCode: "SP", sizeLabel: "183CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 160000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-94", code: "2008(A)-(SK)", name: "TRION(A) (HB STRAIGHT) BEDFRAME (200X200CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) (hb straight) bedframe super king 200x200cm", baseModel: "2008(A)", sizeCode: "SK", sizeLabel: "200CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 160000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-95", code: "2008(A)-(152X200)", name: "TRION(A) (HB STRAIGHT) BEDFRAME (152X200CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) (hb straight) bedframe 152x200cm", baseModel: "2008(A)", sizeCode: "152X200", sizeLabel: "152CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 140000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-96", code: "2009-(K)", name: "TRION BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion bedframe king 6ft (183x190cm)", baseModel: "2009", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-97", code: "2009-(Q)", name: "TRION BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion bedframe queen 5ft (152x190cm)", baseModel: "2009", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-98", code: "2009-(S)", name: "TRION BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion bedframe single 3ft (90x190cm)", baseModel: "2009", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 64000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-99", code: "2009-(SS)", name: "TRION BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion bedframe super single 3.5ft (107x190cm)", baseModel: "2009", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-100", code: "2009(A)-(K)", name: "TRION(A) BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) bedframe king 6ft (183x190cm)", baseModel: "2009(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-101", code: "2009(A)-(Q)", name: "TRION(A) BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) bedframe queen 5ft (152x190cm)", baseModel: "2009(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-102", code: "2009(A)-(S)", name: "TRION(A) BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) bedframe single 3ft (90x190cm)", baseModel: "2009(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 64000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-103", code: "2009(A)-(SS)", name: "TRION(A) BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) bedframe super single 3.5ft (107x190cm)", baseModel: "2009(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-104", code: "2009(A)-(SP)", name: "TRION(A) BEDFRAME (210X210CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) bedframe 210x210cm", baseModel: "2009(A)", sizeCode: "SP", sizeLabel: "210CMX210CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 160000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-105", code: "2009(A)-(SK)", name: "TRION(A) BEDFRAME (200X200CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) bedframe super king 200x200cm", baseModel: "2009(A)", sizeCode: "SK", sizeLabel: "200CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 160000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-106", code: "2009(A)-(152X200)", name: "TRION(A) BEDFRAME (152X200CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) bedframe 152x200cm", baseModel: "2009(A)", sizeCode: "152X200", sizeLabel: "152CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 140000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-107", code: "2010(A)-(K)", name: "TRION(A) WITHOUT PIPING BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) without piping bedframe king 6ft (183x190cm)", baseModel: "2010(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-108", code: "2010(A)-(Q)", name: "TRION(A) WITHOUT PIPING BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) without piping bedframe queen 5ft (152x190cm)", baseModel: "2010(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-109", code: "2010(A)-(S)", name: "TRION(A) WITHOUT PIPING BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) without piping bedframe single 3ft (90x190cm)", baseModel: "2010(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 64000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-110", code: "2010(A)-(SS)", name: "TRION(A) WITHOUT PIPING BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) without piping bedframe super single 3.5ft (107x190cm)", baseModel: "2010(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-111", code: "2011(A)-(K)", name: "TRION(A) W/O PIPING (HB STRAIGHT) BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) w/o piping (hb straight) bedframe king 6ft (183x190cm)", baseModel: "2011(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-112", code: "2011(A)-(Q)", name: "TRION(A) W/O PIPING (HB STRAIGHT) BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) w/o piping (hb straight) bedframe queen 5ft (152x190cm)", baseModel: "2011(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-113", code: "2011(A)-(S)", name: "TRION(A) W/O PIPING (HB STRAIGHT) BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) w/o piping (hb straight) bedframe single 3ft (90x190cm)", baseModel: "2011(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 64000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-114", code: "2011(A)-(SS)", name: "TRION(A) W/O PIPING (HB STRAIGHT) BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) w/o piping (hb straight) bedframe super single 3.5ft (107x190cm)", baseModel: "2011(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-115", code: "2011(A)-(SK)", name: "TRION(A) W/O PIPING (HB STRAIGHT) BEDFRAME (200X200CM)", category: "BEDFRAME" as ItemCategory, description: "trion(a) w/o piping (hb straight) bedframe super king 200x200cm", baseModel: "2011(A)", sizeCode: "SK", sizeLabel: "200CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 160000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-116", code: "2023-(K)", name: "ADJUSTABLE BEDFRAME (6FT)", category: "BEDFRAME" as ItemCategory, description: "adjustable bedframe king 6ft", baseModel: "2023", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-117", code: "2023(HF)(W)-(K)", name: "ADJUSTABLE BEDFRAME (HF)(W) (6FT)", category: "BEDFRAME" as ItemCategory, description: "adjustable bedframe (hf)(w) king 6ft", baseModel: "2023(HF)(W)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-118", code: "2023(HF)(W)-(S)", name: "ADJUSTABLE BEDFRAME (HF)(W) (3FT)", category: "BEDFRAME" as ItemCategory, description: "adjustable bedframe (hf)(w) single 3ft", baseModel: "2023(HF)(W)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 56000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-119", code: "2027-(K)", name: "NINA BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "nina bedframe king 6ft (183x190cm)", baseModel: "2027", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 80000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-120", code: "2027-(Q)", name: "NINA BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "nina bedframe queen 5ft (152x190cm)", baseModel: "2027", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-121", code: "2027-(S)", name: "NINA BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "nina bedframe single 3ft (90x190cm)", baseModel: "2027", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 64000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-122", code: "2027-(SS)", name: "NINA BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "nina bedframe super single 3.5ft (107x190cm)", baseModel: "2027", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-123", code: "2038(A)-(K)", name: "CELENE(A) BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "celene(a) bedframe king 6ft (183x190cm)", baseModel: "2038(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 68000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-124", code: "2038(A)-(Q)", name: "CELENE(A) BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "celene(a) bedframe queen 5ft (152x190cm)", baseModel: "2038(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 56000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-125", code: "2038(A)-(S)", name: "CELENE(A) BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "celene(a) bedframe single 3ft (90x190cm)", baseModel: "2038(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 50000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-126", code: "2038(A)-(SS)", name: "CELENE(A) BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "celene(a) bedframe super single 3.5ft (107x190cm)", baseModel: "2038(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 53000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-127", code: "2038(A)(HF)(W)-(K)", name: "CELENE(A) BEDFRAME (HF)(W) (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "celene(a) bedframe (hf)(w) king 6ft (183x190cm)", baseModel: "2038(A)(HF)(W)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 68000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-128", code: "2038(A)(HF)(W)-(Q)", name: "CELENE(A) BEDFRAME (HF)(W) (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "celene(a) bedframe (hf)(w) queen 5ft (152x190cm)", baseModel: "2038(A)(HF)(W)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 56000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-129", code: "2041(A)-(K)", name: "ELEGANT(A) BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "elegant(a) bedframe king 6ft (183x190cm)", baseModel: "2041(A)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 68000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-130", code: "2041(A)-(Q)", name: "ELEGANT(A) BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "elegant(a) bedframe queen 5ft (152x190cm)", baseModel: "2041(A)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 56000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-131", code: "2041(A)-(SS)", name: "ELEGANT(A) BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "elegant(a) bedframe super single 3.5ft (107x190cm)", baseModel: "2041(A)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 53000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-132", code: "2041(A)-(S)", name: "ELEGANT(A) BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "elegant(a) bedframe single 3ft (90x190cm)", baseModel: "2041(A)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 50000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-133", code: "2033-(K)", name: "JACOB BEDFRAME (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "jacob bedframe king 6ft (183x190cm)", baseModel: "2033", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 82000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-134", code: "2033-(Q)", name: "JACOB BEDFRAME (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "jacob bedframe queen 5ft (152x190cm)", baseModel: "2033", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-135", code: "2033-(S)", name: "JACOB BEDFRAME (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "jacob bedframe single 3ft (90x190cm)", baseModel: "2033", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 64000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-136", code: "2033-(SS)", name: "JACOB BEDFRAME (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "jacob bedframe super single 3.5ft (107x190cm)", baseModel: "2033", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-137", code: "2033(HF)(W)-(K)", name: "JACOB BEDFRAME (HF)(W) (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "jacob bedframe (hf)(w) king 6ft (183x190cm)", baseModel: "2033(HF)(W)", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-138", code: "2033(HF)(W)-(Q)", name: "JACOB BEDFRAME (HF)(W) (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "jacob bedframe (hf)(w) queen 5ft (152x190cm)", baseModel: "2033(HF)(W)", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 70000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-139", code: "2033(HF)(W)-(S)", name: "JACOB BEDFRAME (HF)(W) (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "jacob bedframe (hf)(w) single 3ft (90x190cm)", baseModel: "2033(HF)(W)", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 64000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-140", code: "2033(HF)(W)-(SS)", name: "JACOB BEDFRAME (HF)(W) (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "jacob bedframe (hf)(w) super single 3.5ft (107x190cm)", baseModel: "2033(HF)(W)", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 67000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-141", code: "DIVAN-(210)", name: "DIVAN ONLY (210X210CM)", category: "BEDFRAME" as ItemCategory, description: "divan only 210x210cm", baseModel: "DIVAN", sizeCode: "210", sizeLabel: "210CMX210CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 88200, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-142", code: "DIVAN-(200)", name: "DIVAN ONLY (200X200CM)", category: "BEDFRAME" as ItemCategory, description: "divan only 200x200cm", baseModel: "DIVAN", sizeCode: "200", sizeLabel: "200CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 82000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-143", code: "DIVAN-(210X200)", name: "DIVAN ONLY (210X200CM)", category: "BEDFRAME" as ItemCategory, description: "divan only 210x200cm", baseModel: "DIVAN", sizeCode: "210X200", sizeLabel: "210CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 82000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-144", code: "DIVAN-(170)", name: "DIVAN ONLY (170X200CM)", category: "BEDFRAME" as ItemCategory, description: "divan only 170x200cm", baseModel: "DIVAN", sizeCode: "170", sizeLabel: "170CMX200CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 71400, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-145", code: "DIVAN-(153)", name: "DIVAN ONLY (153X210CM)", category: "BEDFRAME" as ItemCategory, description: "divan only 153x210cm", baseModel: "DIVAN", sizeCode: "153", sizeLabel: "153CMX210CM", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 60000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-146", code: "DIVAN-(K)", name: "DIVAN ONLY (6FT) (183X190CM)", category: "BEDFRAME" as ItemCategory, description: "divan only king 6ft (183x190cm)", baseModel: "DIVAN", sizeCode: "K", sizeLabel: "6FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 42000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-147", code: "DIVAN-(Q)", name: "DIVAN ONLY (5FT) (152X190CM)", category: "BEDFRAME" as ItemCategory, description: "divan only queen 5ft (152x190cm)", baseModel: "DIVAN", sizeCode: "Q", sizeLabel: "5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 30000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-148", code: "DIVAN-(S)", name: "DIVAN ONLY (3FT) (90X190CM)", category: "BEDFRAME" as ItemCategory, description: "divan only single 3ft (90x190cm)", baseModel: "DIVAN", sizeCode: "S", sizeLabel: "3FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 28000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-149", code: "DIVAN-(SS)", name: "DIVAN ONLY (3.5FT) (107X190CM)", category: "BEDFRAME" as ItemCategory, description: "divan only super single 3.5ft (107x190cm)", baseModel: "DIVAN", sizeCode: "SS", sizeLabel: "3.5FT", fabricUsage: 4, unitM3: 0.95, status: "ACTIVE", costPriceSen: 0, basePriceSen: 29000, productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-150", code: "5530-1NA", name: "SOFA 5530 1NA", category: "SOFA" as ItemCategory, description: "sofa 5530 module 1NA", baseModel: "5530", sizeCode: "1NA", sizeLabel: "1NA", fabricUsage: 4, unitM3: 0.69, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 51700 }, { height: "28", priceSen: 57200 }, { height: "30", priceSen: 57200 }, { height: "32", priceSen: 77200 }, { height: "35", priceSen: 77200 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-151", code: "5530-2NA", name: "SOFA 5530 2NA", category: "SOFA" as ItemCategory, description: "sofa 5530 module 2NA", baseModel: "5530", sizeCode: "2NA", sizeLabel: "2NA", fabricUsage: 4, unitM3: 1.35, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 102900 }, { height: "28", priceSen: 107800 }, { height: "30", priceSen: 113300 }, { height: "32", priceSen: 133300 }, { height: "35", priceSen: 133300 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-152", code: "5530-1A(LHF)", name: "SOFA 5530 1A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5530 module 1A(LHF)", baseModel: "5530", sizeCode: "1A(LHF)", sizeLabel: "1A(LHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 55000 }, { height: "28", priceSen: 64900 }, { height: "30", priceSen: 64900 }, { height: "32", priceSen: 84900 }, { height: "35", priceSen: 84900 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-153", code: "5530-1A(RHF)", name: "SOFA 5530 1A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5530 module 1A(RHF)", baseModel: "5530", sizeCode: "1A(RHF)", sizeLabel: "1A(RHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 55000 }, { height: "28", priceSen: 64900 }, { height: "30", priceSen: 64900 }, { height: "32", priceSen: 84900 }, { height: "35", priceSen: 84900 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-154", code: "5530-2A(LHF)", name: "SOFA 5530 2A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5530 module 2A(LHF)", baseModel: "5530", sizeCode: "2A(LHF)", sizeLabel: "2A(LHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 104500 }, { height: "28", priceSen: 110000 }, { height: "30", priceSen: 114400 }, { height: "32", priceSen: 134400 }, { height: "35", priceSen: 134400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-155", code: "5530-2A(RHF)", name: "SOFA 5530 2A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5530 module 2A(RHF)", baseModel: "5530", sizeCode: "2A(RHF)", sizeLabel: "2A(RHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 104500 }, { height: "28", priceSen: 110000 }, { height: "30", priceSen: 114400 }, { height: "32", priceSen: 134400 }, { height: "35", priceSen: 134400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-156", code: "5530-L(LHF)", name: "SOFA 5530 L(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5530 module L(LHF)", baseModel: "5530", sizeCode: "L(LHF)", sizeLabel: "L(LHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 110000 }, { height: "28", priceSen: 115500 }, { height: "30", priceSen: 120500 }, { height: "32", priceSen: 140500 }, { height: "35", priceSen: 140500 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-157", code: "5530-L(RHF)", name: "SOFA 5530 L(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5530 module L(RHF)", baseModel: "5530", sizeCode: "L(RHF)", sizeLabel: "L(RHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 110000 }, { height: "28", priceSen: 115500 }, { height: "30", priceSen: 120500 }, { height: "32", priceSen: 140500 }, { height: "35", priceSen: 140500 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-158", code: "5530-CNR", name: "SOFA 5530 CNR", category: "SOFA" as ItemCategory, description: "sofa 5530 module CNR", baseModel: "5530", sizeCode: "CNR", sizeLabel: "CNR", fabricUsage: 4, unitM3: 2.08, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 90200 }, { height: "28", priceSen: 90200 }, { height: "30", priceSen: 90200 }, { height: "32", priceSen: 110200 }, { height: "35", priceSen: 110200 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-159", code: "5530-3S", name: "SOFA 5530 3S", category: "SOFA" as ItemCategory, description: "sofa 5530 module 3S", baseModel: "5530", sizeCode: "3S", sizeLabel: "3S", fabricUsage: 4, unitM3: 2.6, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 157300 }, { height: "28", priceSen: 162100 }, { height: "30", priceSen: 174900 }, { height: "32", priceSen: 194900 }, { height: "35", priceSen: 194900 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES, skuCode: "OS30-3S-OSL01", fabricColor: "FG66170-2", pieces: { count: 5, names: ["Frame", "Back Cushion L", "Back Cushion R", "Seat Cushion", "Armrest Pair"] } },
  { id: "prod-160", code: "5530-2S", name: "SOFA 5530 2S", category: "SOFA" as ItemCategory, description: "sofa 5530 module 2S", baseModel: "5530", sizeCode: "2S", sizeLabel: "2S", fabricUsage: 4, unitM3: 1.96, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 118000 }, { height: "28", priceSen: 121700 }, { height: "30", priceSen: 132000 }, { height: "32", priceSen: 152000 }, { height: "35", priceSen: 152000 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES, skuCode: "OS30-2S-OSL01", fabricColor: "FG66170-2", pieces: { count: 4, names: ["Frame", "Back Cushion", "Seat Cushion", "Armrest Pair"] } },
  { id: "prod-161", code: "5530-1S", name: "SOFA 5530 1S", category: "SOFA" as ItemCategory, description: "sofa 5530 module 1S", baseModel: "5530", sizeCode: "1S", sizeLabel: "1S", fabricUsage: 4, unitM3: 0.97, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 82200 }, { height: "28", priceSen: 84700 }, { height: "30", priceSen: 91900 }, { height: "32", priceSen: 111900 }, { height: "35", priceSen: 111900 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-162", code: "5531-1NA", name: "SOFA 5531 1NA", category: "SOFA" as ItemCategory, description: "sofa 5531 module 1NA", baseModel: "5531", sizeCode: "1NA", sizeLabel: "1NA", fabricUsage: 4, unitM3: 0.69, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 52000 }, { height: "28", priceSen: 52000 }, { height: "30", priceSen: 52000 }, { height: "32", priceSen: 72000 }, { height: "35", priceSen: 72000 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-163", code: "5531-2NA", name: "SOFA 5531 2NA", category: "SOFA" as ItemCategory, description: "sofa 5531 module 2NA", baseModel: "5531", sizeCode: "2NA", sizeLabel: "2NA", fabricUsage: 4, unitM3: 1.35, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 93600 }, { height: "28", priceSen: 93600 }, { height: "30", priceSen: 93600 }, { height: "32", priceSen: 113600 }, { height: "35", priceSen: 113600 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-164", code: "5531-1A(LHF)", name: "SOFA 5531 1A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5531 module 1A(LHF)", baseModel: "5531", sizeCode: "1A(LHF)", sizeLabel: "1A(LHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 69000 }, { height: "28", priceSen: 73800 }, { height: "30", priceSen: 73800 }, { height: "32", priceSen: 93800 }, { height: "35", priceSen: 93800 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-165", code: "5531-1A(RHF)", name: "SOFA 5531 1A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5531 module 1A(RHF)", baseModel: "5531", sizeCode: "1A(RHF)", sizeLabel: "1A(RHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 69000 }, { height: "28", priceSen: 73800 }, { height: "30", priceSen: 73800 }, { height: "32", priceSen: 93800 }, { height: "35", priceSen: 93800 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-166", code: "5531-2A(LHF)", name: "SOFA 5531 2A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5531 module 2A(LHF)", baseModel: "5531", sizeCode: "2A(LHF)", sizeLabel: "2A(LHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 102400 }, { height: "28", priceSen: 109100 }, { height: "30", priceSen: 109100 }, { height: "32", priceSen: 129100 }, { height: "35", priceSen: 129100 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-167", code: "5531-2A(RHF)", name: "SOFA 5531 2A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5531 module 2A(RHF)", baseModel: "5531", sizeCode: "2A(RHF)", sizeLabel: "2A(RHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 102400 }, { height: "28", priceSen: 109100 }, { height: "30", priceSen: 109100 }, { height: "32", priceSen: 129100 }, { height: "35", priceSen: 129100 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-168", code: "5531-L(LHF)", name: "SOFA 5531 L(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5531 module L(LHF)", baseModel: "5531", sizeCode: "L(LHF)", sizeLabel: "L(LHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 95100 }, { height: "28", priceSen: 98800 }, { height: "30", priceSen: 98800 }, { height: "32", priceSen: 118800 }, { height: "35", priceSen: 118800 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-169", code: "5531-L(RHF)", name: "SOFA 5531 L(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5531 module L(RHF)", baseModel: "5531", sizeCode: "L(RHF)", sizeLabel: "L(RHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 95100 }, { height: "28", priceSen: 98800 }, { height: "30", priceSen: 98800 }, { height: "32", priceSen: 118800 }, { height: "35", priceSen: 118800 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-170", code: "5531-CNR", name: "SOFA 5531 CNR", category: "SOFA" as ItemCategory, description: "sofa 5531 module CNR", baseModel: "5531", sizeCode: "CNR", sizeLabel: "CNR", fabricUsage: 4, unitM3: 2.08, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 83200 }, { height: "28", priceSen: 83200 }, { height: "30", priceSen: 83200 }, { height: "32", priceSen: 103200 }, { height: "35", priceSen: 103200 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-171", code: "5531-3S", name: "SOFA 5531 3S", category: "SOFA" as ItemCategory, description: "sofa 5531 module 3S", baseModel: "5531", sizeCode: "3S", sizeLabel: "3S", fabricUsage: 4, unitM3: 2.6, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 146400 }, { height: "28", priceSen: 155500 }, { height: "30", priceSen: 155500 }, { height: "32", priceSen: 175500 }, { height: "35", priceSen: 175500 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-172", code: "5531-2S", name: "SOFA 5531 2S", category: "SOFA" as ItemCategory, description: "sofa 5531 module 2S", baseModel: "5531", sizeCode: "2S", sizeLabel: "2S", fabricUsage: 4, unitM3: 1.96, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 109800 }, { height: "28", priceSen: 116600 }, { height: "30", priceSen: 116600 }, { height: "32", priceSen: 136600 }, { height: "35", priceSen: 136600 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-173", code: "5531-1S", name: "SOFA 5531 1S", category: "SOFA" as ItemCategory, description: "sofa 5531 module 1S", baseModel: "5531", sizeCode: "1S", sizeLabel: "1S", fabricUsage: 4, unitM3: 0.97, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 76500 }, { height: "28", priceSen: 81300 }, { height: "30", priceSen: 81300 }, { height: "32", priceSen: 101300 }, { height: "35", priceSen: 101300 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-174", code: "5535-1NA", name: "SOFA 5535 1NA", category: "SOFA" as ItemCategory, description: "sofa 5535 module 1NA", baseModel: "5535", sizeCode: "1NA", sizeLabel: "1NA", fabricUsage: 4, unitM3: 0.69, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 58300 }, { height: "28", priceSen: 58300 }, { height: "30", priceSen: 58300 }, { height: "32", priceSen: 78300 }, { height: "35", priceSen: 78300 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-175", code: "5535-2NA", name: "SOFA 5535 2NA", category: "SOFA" as ItemCategory, description: "sofa 5535 module 2NA", baseModel: "5535", sizeCode: "2NA", sizeLabel: "2NA", fabricUsage: 4, unitM3: 1.35, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 94500 }, { height: "28", priceSen: 94500 }, { height: "30", priceSen: 94500 }, { height: "32", priceSen: 114500 }, { height: "35", priceSen: 114500 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-176", code: "5535-1A(LHF)", name: "SOFA 5535 1A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5535 module 1A(LHF)", baseModel: "5535", sizeCode: "1A(LHF)", sizeLabel: "1A(LHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 61200 }, { height: "28", priceSen: 66000 }, { height: "30", priceSen: 66000 }, { height: "32", priceSen: 86000 }, { height: "35", priceSen: 86000 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-177", code: "5535-1A(RHF)", name: "SOFA 5535 1A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5535 module 1A(RHF)", baseModel: "5535", sizeCode: "1A(RHF)", sizeLabel: "1A(RHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 61200 }, { height: "28", priceSen: 66000 }, { height: "30", priceSen: 66000 }, { height: "32", priceSen: 86000 }, { height: "35", priceSen: 86000 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-178", code: "5535-2A(LHF)", name: "SOFA 5535 2A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5535 module 2A(LHF)", baseModel: "5535", sizeCode: "2A(LHF)", sizeLabel: "2A(LHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 55000 }, { height: "28", priceSen: 64900 }, { height: "30", priceSen: 64900 }, { height: "32", priceSen: 84900 }, { height: "35", priceSen: 84900 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-179", code: "5535-2A(RHF)", name: "SOFA 5535 2A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5535 module 2A(RHF)", baseModel: "5535", sizeCode: "2A(RHF)", sizeLabel: "2A(RHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 55000 }, { height: "28", priceSen: 64900 }, { height: "30", priceSen: 64900 }, { height: "32", priceSen: 84900 }, { height: "35", priceSen: 84900 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-180", code: "5535-L(LHF)", name: "SOFA 5535 L(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5535 module L(LHF)", baseModel: "5535", sizeCode: "L(LHF)", sizeLabel: "L(LHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 104500 }, { height: "28", priceSen: 110000 }, { height: "30", priceSen: 114400 }, { height: "32", priceSen: 134400 }, { height: "35", priceSen: 134400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-181", code: "5535-L(RHF)", name: "SOFA 5535 L(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5535 module L(RHF)", baseModel: "5535", sizeCode: "L(RHF)", sizeLabel: "L(RHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 104500 }, { height: "28", priceSen: 110000 }, { height: "30", priceSen: 114400 }, { height: "32", priceSen: 134400 }, { height: "35", priceSen: 134400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-182", code: "5535-CNR", name: "SOFA 5535 CNR", category: "SOFA" as ItemCategory, description: "sofa 5535 module CNR", baseModel: "5535", sizeCode: "CNR", sizeLabel: "CNR", fabricUsage: 4, unitM3: 2.08, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 83200 }, { height: "28", priceSen: 83200 }, { height: "30", priceSen: 83200 }, { height: "32", priceSen: 103200 }, { height: "35", priceSen: 103200 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-183", code: "5535-3S", name: "SOFA 5535 3S", category: "SOFA" as ItemCategory, description: "sofa 5535 module 3S", baseModel: "5535", sizeCode: "3S", sizeLabel: "3S", fabricUsage: 4, unitM3: 2.6, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 155400 }, { height: "28", priceSen: 164500 }, { height: "30", priceSen: 164500 }, { height: "32", priceSen: 184500 }, { height: "35", priceSen: 184500 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-184", code: "5535-2S", name: "SOFA 5535 2S", category: "SOFA" as ItemCategory, description: "sofa 5535 module 2S", baseModel: "5535", sizeCode: "2S", sizeLabel: "2S", fabricUsage: 4, unitM3: 1.96, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 116600 }, { height: "28", priceSen: 123400 }, { height: "30", priceSen: 123400 }, { height: "32", priceSen: 143400 }, { height: "35", priceSen: 143400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-185", code: "5535-1S", name: "SOFA 5535 1S", category: "SOFA" as ItemCategory, description: "sofa 5535 module 1S", baseModel: "5535", sizeCode: "1S", sizeLabel: "1S", fabricUsage: 4, unitM3: 0.97, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 81200 }, { height: "28", priceSen: 86000 }, { height: "30", priceSen: 86000 }, { height: "32", priceSen: 106000 }, { height: "35", priceSen: 106000 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-186", code: "5536-1NA", name: "SOFA 5536 1NA", category: "SOFA" as ItemCategory, description: "sofa 5536 module 1NA", baseModel: "5536", sizeCode: "1NA", sizeLabel: "1NA", fabricUsage: 4, unitM3: 0.69, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 51700 }, { height: "28", priceSen: 53900 }, { height: "30", priceSen: 53900 }, { height: "32", priceSen: 73900 }, { height: "35", priceSen: 73900 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-187", code: "5536-2NA", name: "SOFA 5536 2NA", category: "SOFA" as ItemCategory, description: "sofa 5536 module 2NA", baseModel: "5536", sizeCode: "2NA", sizeLabel: "2NA", fabricUsage: 4, unitM3: 1.35, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 103400 }, { height: "28", priceSen: 107800 }, { height: "30", priceSen: 107800 }, { height: "32", priceSen: 127800 }, { height: "35", priceSen: 127800 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-188", code: "5536-1A(LHF)", name: "SOFA 5536 1A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5536 module 1A(LHF)", baseModel: "5536", sizeCode: "1A(LHF)", sizeLabel: "1A(LHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 60500 }, { height: "28", priceSen: 62700 }, { height: "30", priceSen: 62700 }, { height: "32", priceSen: 82700 }, { height: "35", priceSen: 82700 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-189", code: "5536-1A(RHF)", name: "SOFA 5536 1A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5536 module 1A(RHF)", baseModel: "5536", sizeCode: "1A(RHF)", sizeLabel: "1A(RHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 60500 }, { height: "28", priceSen: 62700 }, { height: "30", priceSen: 62700 }, { height: "32", priceSen: 82700 }, { height: "35", priceSen: 82700 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-190", code: "5536-2A(LHF)", name: "SOFA 5536 2A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5536 module 2A(LHF)", baseModel: "5536", sizeCode: "2A(LHF)", sizeLabel: "2A(LHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 108900 }, { height: "28", priceSen: 114400 }, { height: "30", priceSen: 114400 }, { height: "32", priceSen: 134400 }, { height: "35", priceSen: 134400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-191", code: "5536-2A(RHF)", name: "SOFA 5536 2A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5536 module 2A(RHF)", baseModel: "5536", sizeCode: "2A(RHF)", sizeLabel: "2A(RHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 108900 }, { height: "28", priceSen: 114400 }, { height: "30", priceSen: 114400 }, { height: "32", priceSen: 134400 }, { height: "35", priceSen: 134400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-192", code: "5536-L(LHF)", name: "SOFA 5536 L(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5536 module L(LHF)", baseModel: "5536", sizeCode: "L(LHF)", sizeLabel: "L(LHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 115500 }, { height: "28", priceSen: 121000 }, { height: "30", priceSen: 121000 }, { height: "32", priceSen: 141000 }, { height: "35", priceSen: 141000 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-193", code: "5536-L(RHF)", name: "SOFA 5536 L(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5536 module L(RHF)", baseModel: "5536", sizeCode: "L(RHF)", sizeLabel: "L(RHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 115500 }, { height: "28", priceSen: 121000 }, { height: "30", priceSen: 121000 }, { height: "32", priceSen: 141000 }, { height: "35", priceSen: 141000 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-194", code: "5536-CNR", name: "SOFA 5536 CNR", category: "SOFA" as ItemCategory, description: "sofa 5536 module CNR", baseModel: "5536", sizeCode: "CNR", sizeLabel: "CNR", fabricUsage: 4, unitM3: 2.08, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 89100 }, { height: "28", priceSen: 89100 }, { height: "30", priceSen: 89100 }, { height: "32", priceSen: 109100 }, { height: "35", priceSen: 109100 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-195", code: "5536-CSL", name: "SOFA 5536 CSL", category: "SOFA" as ItemCategory, description: "sofa 5536 module CSL", baseModel: "5536", sizeCode: "CSL", sizeLabel: "CSL", fabricUsage: 4, unitM3: 0.34, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 32000 }, { height: "28", priceSen: 32000 }, { height: "30", priceSen: 32000 }, { height: "32", priceSen: 32000 }, { height: "35", priceSen: 32000 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-196", code: "5536-3S", name: "SOFA 5536 3S", category: "SOFA" as ItemCategory, description: "sofa 5536 module 3S", baseModel: "5536", sizeCode: "3S", sizeLabel: "3S", fabricUsage: 4, unitM3: 2.6, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 169400 }, { height: "28", priceSen: 169400 }, { height: "30", priceSen: 169400 }, { height: "32", priceSen: 189400 }, { height: "35", priceSen: 189400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-197", code: "5536-2S", name: "SOFA 5536 2S", category: "SOFA" as ItemCategory, description: "sofa 5536 module 2S", baseModel: "5536", sizeCode: "2S", sizeLabel: "2S", fabricUsage: 4, unitM3: 1.96, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 129500 }, { height: "28", priceSen: 129500 }, { height: "30", priceSen: 129500 }, { height: "32", priceSen: 149500 }, { height: "35", priceSen: 149500 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-198", code: "5536-1S", name: "SOFA 5536 1S", category: "SOFA" as ItemCategory, description: "sofa 5536 module 1S", baseModel: "5536", sizeCode: "1S", sizeLabel: "1S", fabricUsage: 4, unitM3: 0.97, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 90800 }, { height: "28", priceSen: 90800 }, { height: "30", priceSen: 90800 }, { height: "32", priceSen: 110800 }, { height: "35", priceSen: 110800 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-199", code: "5537-1NA", name: "SOFA 5537 1NA", category: "SOFA" as ItemCategory, description: "sofa 5537 module 1NA", baseModel: "5537", sizeCode: "1NA", sizeLabel: "1NA", fabricUsage: 4, unitM3: 0.69, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 59400 }, { height: "28", priceSen: 59400 }, { height: "30", priceSen: 59400 }, { height: "32", priceSen: 80300 }, { height: "35", priceSen: 80300 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-200", code: "5537-2NA", name: "SOFA 5537 2NA", category: "SOFA" as ItemCategory, description: "sofa 5537 module 2NA", baseModel: "5537", sizeCode: "2NA", sizeLabel: "2NA", fabricUsage: 4, unitM3: 1.35, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 118800 }, { height: "28", priceSen: 118800 }, { height: "30", priceSen: 118800 }, { height: "32", priceSen: 160600 }, { height: "35", priceSen: 160600 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-201", code: "5537-1A(LHF)", name: "SOFA 5537 1A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5537 module 1A(LHF)", baseModel: "5537", sizeCode: "1A(LHF)", sizeLabel: "1A(LHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 75600 }, { height: "28", priceSen: 77800 }, { height: "30", priceSen: 77800 }, { height: "32", priceSen: 106400 }, { height: "35", priceSen: 106400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-202", code: "5537-1A(RHF)", name: "SOFA 5537 1A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5537 module 1A(RHF)", baseModel: "5537", sizeCode: "1A(RHF)", sizeLabel: "1A(RHF)", fabricUsage: 4, unitM3: 0.99, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 75600 }, { height: "28", priceSen: 77800 }, { height: "30", priceSen: 77800 }, { height: "32", priceSen: 106400 }, { height: "35", priceSen: 106400 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-203", code: "5537-2A(LHF)", name: "SOFA 5537 2A(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5537 module 2A(LHF)", baseModel: "5537", sizeCode: "2A(LHF)", sizeLabel: "2A(LHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 112100 }, { height: "28", priceSen: 117600 }, { height: "30", priceSen: 117600 }, { height: "32", priceSen: 158600 }, { height: "35", priceSen: 158600 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-204", code: "5537-2A(RHF)", name: "SOFA 5537 2A(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5537 module 2A(RHF)", baseModel: "5537", sizeCode: "2A(RHF)", sizeLabel: "2A(RHF)", fabricUsage: 4, unitM3: 1.66, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 112100 }, { height: "28", priceSen: 117600 }, { height: "30", priceSen: 117600 }, { height: "32", priceSen: 158600 }, { height: "35", priceSen: 158600 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-205", code: "5537-L(LHF)", name: "SOFA 5537 L(LHF)", category: "SOFA" as ItemCategory, description: "sofa 5537 module L(LHF)", baseModel: "5537", sizeCode: "L(LHF)", sizeLabel: "L(LHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 104500 }, { height: "28", priceSen: 110000 }, { height: "30", priceSen: 110000 }, { height: "32", priceSen: 116600 }, { height: "35", priceSen: 116600 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-206", code: "5537-L(RHF)", name: "SOFA 5537 L(RHF)", category: "SOFA" as ItemCategory, description: "sofa 5537 module L(RHF)", baseModel: "5537", sizeCode: "L(RHF)", sizeLabel: "L(RHF)", fabricUsage: 4, unitM3: 1.94, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 104500 }, { height: "28", priceSen: 110000 }, { height: "30", priceSen: 110000 }, { height: "32", priceSen: 116600 }, { height: "35", priceSen: 116600 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-207", code: "5537-STOOL", name: "SOFA 5537 STOOL", category: "SOFA" as ItemCategory, description: "sofa 5537 module STOOL", baseModel: "5537", sizeCode: "STOOL", sizeLabel: "STOOL", fabricUsage: 4, unitM3: 0.69, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 50000 }, { height: "28", priceSen: 50000 }, { height: "30", priceSen: 50000 }, { height: "32", priceSen: 50000 }, { height: "35", priceSen: 50000 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-208", code: "5537-CNR", name: "SOFA 5537 CNR", category: "SOFA" as ItemCategory, description: "sofa 5537 module CNR", baseModel: "5537", sizeCode: "CNR", sizeLabel: "CNR", fabricUsage: 4, unitM3: 2.08, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 108900 }, { height: "28", priceSen: 108900 }, { height: "30", priceSen: 108900 }, { height: "32", priceSen: 108900 }, { height: "35", priceSen: 108900 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-209", code: "5537-3S", name: "SOFA 5537 3S", category: "SOFA" as ItemCategory, description: "sofa 5537 module 3S", baseModel: "5537", sizeCode: "3S", sizeLabel: "3S", fabricUsage: 4, unitM3: 2.6, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 175200 }, { height: "28", priceSen: 175200 }, { height: "30", priceSen: 175200 }, { height: "32", priceSen: 172800 }, { height: "35", priceSen: 172800 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-210", code: "5537-2S", name: "SOFA 5537 2S", category: "SOFA" as ItemCategory, description: "sofa 5537 module 2S", baseModel: "5537", sizeCode: "2S", sizeLabel: "2S", fabricUsage: 4, unitM3: 1.96, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 131500 }, { height: "28", priceSen: 131500 }, { height: "30", priceSen: 131500 }, { height: "32", priceSen: 172500 }, { height: "35", priceSen: 172500 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
  { id: "prod-211", code: "5537-1S", name: "SOFA 5537 1S", category: "SOFA" as ItemCategory, description: "sofa 5537 module 1S", baseModel: "5537", sizeCode: "1S", sizeLabel: "1S", fabricUsage: 4, unitM3: 0.97, status: "ACTIVE", costPriceSen: 0, seatHeightPrices: [{ height: "24", priceSen: 91600 }, { height: "28", priceSen: 91600 }, { height: "30", priceSen: 91600 }, { height: "32", priceSen: 120200 }, { height: "35", priceSen: 120200 }], productionTimeMinutes: 80, subAssemblies: [], bomComponents: [], deptWorkingTimes: BEDFRAME_DEPT_TIMES },
];


// --- Fabric Inventory (matching Fab Maint sheet) ---
export const fabrics: FabricItem[] = [
  // AVANI series (B.M-FABR) - 18 colors
  { id: "fab-1", code: "AVANI 01", name: "AVANI 01", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-2", code: "AVANI 02", name: "AVANI 02", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-3", code: "AVANI 03", name: "AVANI 03", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-4", code: "AVANI 04", name: "AVANI 04", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-5", code: "AVANI 05", name: "AVANI 05", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-6", code: "AVANI 06", name: "AVANI 06", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-7", code: "AVANI 07", name: "AVANI 07", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-8", code: "AVANI 08", name: "AVANI 08", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-9", code: "AVANI 09", name: "AVANI 09", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-10", code: "AVANI 10", name: "AVANI 10", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-11", code: "AVANI 11", name: "AVANI 11", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-12", code: "AVANI 12", name: "AVANI 12", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-13", code: "AVANI 13", name: "AVANI 13", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-14", code: "AVANI 14", name: "AVANI 14", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-15", code: "AVANI 15", name: "AVANI 15", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-16", code: "AVANI 16", name: "AVANI 16", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-17", code: "AVANI 17", name: "AVANI 17", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-18", code: "AVANI 18", name: "AVANI 18", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  // BN125-4 (S.M-FABR)
  { id: "fab-19", code: "BN125-4", name: "BN125-4", category: "SM_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  // BO315 series (S.M-FABR / S-FABRIC)
  { id: "fab-20", code: "BO315-1", name: "BO315-1", category: "SM_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-21", code: "BO315-2", name: "BO315-2", category: "SM_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-22", code: "BO315-3", name: "BO315-3", category: "S_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-23", code: "BO315-4", name: "BO315-4", category: "S_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  // CH141 series (S.M-FABR)
  { id: "fab-24", code: "CH141-1", name: "CH141-1", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-25", code: "CH141-2", name: "CH141-2", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-26", code: "CH141-3", name: "CH141-3", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-27", code: "CH141-4", name: "CH141-4", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-28", code: "CH141-5", name: "CH141-5", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  // FG66151 series (B.M-FABR)
  { id: "fab-29", code: "FG66151-01", name: "FG66151-01", category: "BM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-30", code: "FG66151-02", name: "FG66151-02", category: "BM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-31", code: "FG66151-03", name: "FG66151-03", category: "BM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-32", code: "FG66151-04", name: "FG66151-04", category: "BM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-33", code: "FG66151-05", name: "FG66151-05", category: "BM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  // FG6876-01 (B.M-FABR)
  { id: "fab-34", code: "FG6876-01", name: "FG6876-01", category: "BM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  // KN390 series (S.M-FABR) - KOONA VELVET sofa fabric
  { id: "fab-35", code: "KN390-1", name: "KN390-1 KOONA VELVET", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-36", code: "KN390-2", name: "KN390-2 KOONA VELVET", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-37", code: "KN390-3", name: "KN390-3 KOONA VELVET", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-38", code: "KN390-4", name: "KN390-4 KOONA VELVET", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-39", code: "KN390-5", name: "KN390-5 KOONA VELVET", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-40", code: "KN390-6", name: "KN390-6 KOONA VELVET", category: "SM_FABRIC", priceSen: 3200, sohMeters: 0, reorderLevel: 100 },
  // KS series (B.M-FABR) - Named colors KS-01 to KS-19
  { id: "fab-41", code: "KS-01", name: "KS-01", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-42", code: "KS-02", name: "KS-02", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-43", code: "KS-03", name: "KS-03", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-44", code: "KS-04", name: "KS-04", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-45", code: "KS-05", name: "KS-05", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-46", code: "KS-06", name: "KS-06", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-47", code: "KS-07", name: "KS-07", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-48", code: "KS-08", name: "KS-08", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-49", code: "KS-09", name: "KS-09", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-50", code: "KS-10", name: "KS-10", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-51", code: "KS-11", name: "KS-11", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-52", code: "KS-12", name: "KS-12", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-53", code: "KS-13", name: "KS-13", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-54", code: "KS-14", name: "KS-14", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-55", code: "KS-15", name: "KS-15", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-56", code: "KS-16", name: "KS-16", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-57", code: "KS-17", name: "KS-17", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-58", code: "KS-18", name: "KS-18", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-59", code: "KS-19", name: "KS-19", category: "BM_FABRIC", priceSen: 2600, sohMeters: 0, reorderLevel: 100 },
  // M2402 series (S.M-FABR)
  { id: "fab-60", code: "M2402-01", name: "M2402-01", category: "SM_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-61", code: "M2402-02", name: "M2402-02", category: "SM_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-62", code: "M2402-03", name: "M2402-03", category: "SM_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-63", code: "M2402-04", name: "M2402-04", category: "SM_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-64", code: "M2402-05", name: "M2402-05", category: "SM_FABRIC", priceSen: 3000, sohMeters: 0, reorderLevel: 100 },
  // NINJA series (S.M-FABR) - 01 to 08
  { id: "fab-65", code: "NINJA 01", name: "NINJA 01", category: "SM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-66", code: "NINJA 02", name: "NINJA 02", category: "SM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-67", code: "NINJA 03", name: "NINJA 03", category: "SM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-68", code: "NINJA 04", name: "NINJA 04", category: "SM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-69", code: "NINJA 05", name: "NINJA 05", category: "SM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-70", code: "NINJA 06", name: "NINJA 06", category: "SM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-71", code: "NINJA 07", name: "NINJA 07", category: "SM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-72", code: "NINJA 08", name: "NINJA 08", category: "SM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  // PC151 series (B.M-FABR) - Main bedframe fabric, 01 to 18
  { id: "fab-73", code: "PC151-01", name: "PC151-01", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-74", code: "PC151-02", name: "PC151-02", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-75", code: "PC151-03", name: "PC151-03", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-76", code: "PC151-04", name: "PC151-04", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-77", code: "PC151-05", name: "PC151-05", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-78", code: "PC151-06", name: "PC151-06", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-79", code: "PC151-07", name: "PC151-07", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-80", code: "PC151-08", name: "PC151-08", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-81", code: "PC151-09", name: "PC151-09", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-82", code: "PC151-10", name: "PC151-10", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-83", code: "PC151-11", name: "PC151-11", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-84", code: "PC151-12", name: "PC151-12", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-85", code: "PC151-13", name: "PC151-13", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-86", code: "PC151-14", name: "PC151-14", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-87", code: "PC151-15", name: "PC151-15", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-88", code: "PC151-16", name: "PC151-16", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-89", code: "PC151-17", name: "PC151-17", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-90", code: "PC151-18", name: "PC151-18", category: "BM_FABRIC", priceSen: 2500, sohMeters: 0, reorderLevel: 100 },
  // SOFA 5535 (B.M-FABR)
  { id: "fab-91", code: "SOFA 5535", name: "SOFA 5535", category: "BM_FABRIC", priceSen: 2800, sohMeters: 0, reorderLevel: 100 },
  // Accessories fabrics (S-FABRIC)
  { id: "fab-92", code: "LC5", name: "LC5", category: "S_FABRIC", priceSen: 1500, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-93", code: "NW", name: "NW Non-Woven", category: "S_FABRIC", priceSen: 800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-94", code: "POLY", name: "POLY Polyester", category: "S_FABRIC", priceSen: 1200, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-95", code: "FELT", name: "FELT", category: "S_FABRIC", priceSen: 1000, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-96", code: "CANVAS", name: "CANVAS", category: "S_FABRIC", priceSen: 1800, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-97", code: "LINING", name: "LINING", category: "S_FABRIC", priceSen: 600, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-98", code: "PIPING", name: "PIPING", category: "S_FABRIC", priceSen: 900, sohMeters: 0, reorderLevel: 100 },
  { id: "fab-99", code: "VELCRO", name: "VELCRO", category: "S_FABRIC", priceSen: 700, sohMeters: 0, reorderLevel: 100 },
];

// --- Raw Materials (from SQL Accounting stock items) ---
export const rawMaterials: RawMaterial[] = [
  { id: "rm-1", itemCode: "18MM 4' X 8'", description: "18MM 4' X 8' MR AA PLYWOOD", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 31 },
  { id: "rm-2", itemCode: "5.5 MDF/B", description: "5.5MM 950 X 1840MM MDF BOARD", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 1485 },
  { id: "rm-3", itemCode: "6MM MDF/B", description: "6MM 4' X 8' MDF BOARD", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 225 },
  { id: "rm-4", itemCode: "9MM 4' X 8'", description: "9MM 4' X 8' MR AA PLYWOOD", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 1778 },
  { id: "rm-5", itemCode: "A.H (T)", description: "AIR HOSE (8.5 X 14.5MM X 100M) TAIWAN KINGTOYO YELLOW", baseUOM: "ROLL", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 1 },
  { id: "rm-6", itemCode: "AC 20SH", description: "AIR COUPLER 20SH NITTO (5PCS X 2 BOX) MADE IN JAPAN", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 10 },
  { id: "rm-7", itemCode: "AM275-1", description: "IVORY", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 35 },
  { id: "rm-8", itemCode: "AP 20PF", description: "AIR PLUG 20 PF", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 10 },
  { id: "rm-9", itemCode: "AP 20PH", description: "AIR PLUG 20 PH", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 10 },
  { id: "rm-10", itemCode: "AP 20PM", description: "AIR PLUG 20 PM", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 10 },
  { id: "rm-11", itemCode: "ASC1007F", description: "C -1007F AIR STAPLES 5,000 PCS X 40 BOX (1CTN)", baseUOM: "BOX", itemGroup: "B.OTHERS", isActive: true, balanceQty: 280 },
  { id: "rm-12", itemCode: "ASC1007F(B)", description: "C-(BLACK) 1007F AIR STAPLES 5,000 PCS X 40 BOX (25CTN)", baseUOM: "BOX", itemGroup: "B.OTHERS", isActive: true, balanceQty: 840 },
  { id: "rm-13", itemCode: "ASC1010F", description: "C -1010F AIR STAPLES 5,000PCS X 40 BOX", baseUOM: "BOX", itemGroup: "B.OTHERS", isActive: true, balanceQty: 120 },
  { id: "rm-14", itemCode: "ASC1019J", description: "C-1019J AIR STAPLES 5,000 PCS X 20 BOX (2CTN)", baseUOM: "BOX", itemGroup: "B.OTHERS", isActive: true, balanceQty: 280 },
  { id: "rm-15", itemCode: "ASC425", description: "C-425 AIR STAPLES 5,000 PCS X 10BOX(1CTN)", baseUOM: "BOX", itemGroup: "B.OTHERS", isActive: true, balanceQty: 60 },
  { id: "rm-16", itemCode: "ASC438", description: "OS-438 AIR STAPLES 5,000 PCS X 10 BOX (3CTN)", baseUOM: "BOX", itemGroup: "B.OTHERS", isActive: true, balanceQty: 230 },
  { id: "rm-17", itemCode: "ASCN50", description: "C-850 AIR STAPLES (N50)", baseUOM: "CTN", itemGroup: "B.OTHERS", isActive: true, balanceQty: 2 },
  { id: "rm-18", itemCode: "AVANI 01", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 6 },
  { id: "rm-19", itemCode: "AVANI 02", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 22 },
  { id: "rm-20", itemCode: "AVANI 03", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-21", itemCode: "AVANI 04", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-22", itemCode: "AVANI 05", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-23", itemCode: "AVANI 06", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-24", itemCode: "AVANI 07", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-25", itemCode: "AVANI 08", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-26", itemCode: "AVANI 09", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-27", itemCode: "AVANI 10", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-28", itemCode: "AVANI 11", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-29", itemCode: "AVANI 12", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-30", itemCode: "AVANI 13", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 7 },
  { id: "rm-31", itemCode: "AVANI 14", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-32", itemCode: "AVANI 15", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-33", itemCode: "AVANI 16", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-34", itemCode: "AVANI 17", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-35", itemCode: "AVANI 18", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-36", itemCode: "BN 1342", description: "BONDED NYLON THREAD CODE : 1342 40/3 2,500METER", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 4 },
  { id: "rm-37", itemCode: "BN 565", description: "BONDED NYLON THREAD CODE : 565, 40/3 (2,500METER)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 10 },
  { id: "rm-38", itemCode: "BN 605", description: "BONDED NYLON THREAD CODE: 605 40/3 (2,500 METER (10ROLL X 1 BOX)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 5 },
  { id: "rm-39", itemCode: "BN 608", description: "BONDED NYLON THREAD CODE: 608 40/3 (2,500 METER (10ROLL X 1 BOX)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 10 },
  { id: "rm-40", itemCode: "BN 614", description: "BONDED NYLON THREAD CODE : 614 40/3 2,500METER", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 0 },
  { id: "rm-41", itemCode: "BN 622", description: "BONDED NYLON THREAD CODE : 622, 40/3 (2,500METER)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 5 },
  { id: "rm-42", itemCode: "BN 629", description: "BONDED NYLON THREAD CODE : 629 40/3 2,500METER", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 29 },
  { id: "rm-43", itemCode: "BN 643", description: "BONDED NYLON THREAD CODE : 643, 40/3 (2,500METER)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 5 },
  { id: "rm-44", itemCode: "BN 651", description: "BONDED NYLON THREAD CODE:651 40/3 2,500 METER", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 5 },
  { id: "rm-45", itemCode: "BN 658", description: "BONDED NYLON THREAD CODED : 658, 40/3 (2,500METER)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 5 },
  { id: "rm-46", itemCode: "BN 659", description: "BONDED NYLON THREAD CODE : 658, 40/3 (2,500METER)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 5 },
  { id: "rm-47", itemCode: "BN 663", description: "BONDED NYLON THREAD CODE : 663, 40/3 (2,500 METER)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 5 },
  { id: "rm-48", itemCode: "BN 668", description: "BONDED NYLON THREAD CODE: 668 40/ 3 (2,500 METER) ( 10ROLL X 1 BOX)", baseUOM: "10", itemGroup: "B.OTHERS", isActive: true, balanceQty: 10 },
  { id: "rm-49", itemCode: "BN 679", description: "BONDED NYLOON THREAD CODE : 679, 40/3 (2,500 METER)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 5 },
  { id: "rm-50", itemCode: "BN 681", description: "BONDED NYLON THREAD CODE : 681 40/3 2,500METER", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 39 },
  { id: "rm-51", itemCode: "BN125-4", description: "FOSSIL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 8 },
  { id: "rm-52", itemCode: "BO315-1", description: "PEARL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 94 },
  { id: "rm-53", itemCode: "BO315-11", description: "METAL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 29 },
  { id: "rm-54", itemCode: "BO315-12", description: "DEEP GREY", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 25 },
  { id: "rm-55", itemCode: "BO315-21", description: "PEARL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 67 },
  { id: "rm-56", itemCode: "BO315-22", description: "FEATHER", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 96 },
  { id: "rm-57", itemCode: "BO315-23", description: "BEIGE", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 75 },
  { id: "rm-58", itemCode: "BO315-25", description: "FOSSIL", baseUOM: "MTR", itemGroup: "S-FABRIC", isActive: true, balanceQty: 48 },
  { id: "rm-59", itemCode: "BO315-3", description: "BEIGE", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 45 },
  { id: "rm-60", itemCode: "BO315-32", description: "DEEP GREY", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 18 },
  { id: "rm-61", itemCode: "BO315-5", description: "FOSSIL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 18 },
  { id: "rm-62", itemCode: "BP 100", description: "BONDED NYLON THREAD CODE : 100 30/3 2,800METER", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 39 },
  { id: "rm-63", itemCode: "BRACKET/DOUBLE", description: "DOUBLE BRACKET", baseUOM: "SET", itemGroup: "B.ACCE", isActive: true, balanceQty: 100 },
  { id: "rm-64", itemCode: "BRACKET/GD", description: "BRACKET GOLD 1.8MM", baseUOM: "PCS", itemGroup: "S.ACC", isActive: true, balanceQty: 504 },
  { id: "rm-65", itemCode: "CALK (B)", description: "ROYAL CHALK COLOUR (MIX) (6 BOX X 2 CTN) YELLOW, BLUE, WHITE", baseUOM: "BOX", itemGroup: "B.OTHERS", isActive: true, balanceQty: 16 },
  { id: "rm-66", itemCode: "CALK (Y)", description: "ROYAL CHALK COLOUR (BLUE,WHITE,YELLOW,RED)", baseUOM: "BOX", itemGroup: "B.OTHERS", isActive: true, balanceQty: 2 },
  { id: "rm-67", itemCode: "CASSNYE-07", description: "FABRIC CASSNYE-07", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 24 },
  { id: "rm-68", itemCode: "CB16-101 E1", description: "16MM 1830 X 2440MM CHIPBOARD 2/S WHITE (MUF) E1", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 0 },
  { id: "rm-69", itemCode: "CBP 1000", description: "LAMINATED GREY CHIPBOARD 1,000 GM 31\" X 43\" (20PCS/2PACK)", baseUOM: "PCS", itemGroup: "R&D", isActive: true, balanceQty: 880 },
  { id: "rm-70", itemCode: "CBP 53", description: "BROWN SINGLE FACER SHEET 53\" ( 30KG X 5 ROLL)", baseUOM: "ROLL", itemGroup: "PACKING", isActive: true, balanceQty: 214 },
  { id: "rm-71", itemCode: "CBP 700", description: "GREY CHIPBOARD 700 GM 31\" X 43\" (50PCS / 1 PACK)", baseUOM: "PCS", itemGroup: "R&D", isActive: true, balanceQty: 300 },
  { id: "rm-72", itemCode: "CH141-1", description: "CREAM", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 50 },
  { id: "rm-73", itemCode: "CH141-11", description: "SILVER", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 50 },
  { id: "rm-74", itemCode: "CH141-13", description: "DEEP GREY", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 18 },
  { id: "rm-75", itemCode: "CH141-14", description: "CHARCOAL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 52 },
  { id: "rm-76", itemCode: "CH141-2", description: "BEIGE", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 54 },
  { id: "rm-77", itemCode: "CH141-5", description: "PEARL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 4 },
  { id: "rm-78", itemCode: "CH141-7", description: "WINE", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 3 },
  { id: "rm-79", itemCode: "CHIPBOARD WHITE 6X8 E1", description: "CHIPBOARD WHITE 6X8 E1", baseUOM: "PCS", itemGroup: "R&D", isActive: true, balanceQty: 5 },
  { id: "rm-80", itemCode: "CL-72", description: "MATTRESS CLIP CL-72 (6000PCS/1 BOX)", baseUOM: "BOX", itemGroup: "S.WEBB", isActive: true, balanceQty: 2 },
  { id: "rm-81", itemCode: "CLM-18MM 4' X 8'", description: "18MM 4' X 8' MR AA PLYWOOD", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 155 },
  { id: "rm-82", itemCode: "CLM-2.5MM MDF/B", description: "2.5MM 4' X 8' MDF BOARD", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 10 },
  { id: "rm-83", itemCode: "CLM-5.5 MDF/B", description: "5.5MM 950 X 1840MM MDF BOARD", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 1980 },
  { id: "rm-84", itemCode: "CLM-6MM MDF/B", description: "6MM 4' X 8' MDF BOARD", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 790 },
  { id: "rm-85", itemCode: "CLM-9MM 4' X 8'", description: "9MM 4' X 8' MR AA PLYWOOD", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 876 },
  { id: "rm-86", itemCode: "CS 9.4", description: "CORD STRING 9.4MM", baseUOM: "KG", itemGroup: "B.OTHERS", isActive: true, balanceQty: 0 },
  { id: "rm-87", itemCode: "CS 9.5", description: "CORD STRING 9.5MM", baseUOM: "KG", itemGroup: "B.OTHERS", isActive: true, balanceQty: 22 },
  { id: "rm-88", itemCode: "DB 36", description: "BUTTON NO. 36", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 1000 },
  { id: "rm-89", itemCode: "DB 36M", description: "BUTTON #36 MOULD", baseUOM: "SET", itemGroup: "B.OTHERS", isActive: true, balanceQty: 1 },
  { id: "rm-90", itemCode: "DB M", description: "BUTTON MACHINE", baseUOM: "UNIT", itemGroup: "B.OTHERS", isActive: true, balanceQty: 1 },
  { id: "rm-91", itemCode: "DIAM20", description: "DIAMOND 20MM (1000 PCS/1BOX)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 0 },
  { id: "rm-92", itemCode: "F EPE-100", description: "EPE FOAM 3MM X 1M X 100M", baseUOM: "MTR", itemGroup: "S.OTHERS", isActive: true, balanceQty: 3 },
  { id: "rm-93", itemCode: "FAB 51BLK-A", description: "51\" FABRIC BLACK (A) (1ROLL X 328YARD)", baseUOM: "YRD", itemGroup: "S-FABRIC", isActive: true, balanceQty: 328 },
  { id: "rm-94", itemCode: "FABR (W) H", description: "98\" FABRIC NET WHITE HOLE (28 METER X 1 ROLL)", baseUOM: "MTR", itemGroup: "S.WEBB", isActive: true, balanceQty: 172 },
  { id: "rm-95", itemCode: "FABR(W) B", description: "60\" FABRIC WHITE JOINT (B)", baseUOM: "YRD", itemGroup: "B.M-FABR", isActive: true, balanceQty: 426 },
  { id: "rm-96", itemCode: "FABRIC HR805-10", description: "FABRIC HR805-10", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 18 },
  { id: "rm-97", itemCode: "FABRIC HR805-90", description: "FABRIC HR805-90", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 30 },
  { id: "rm-98", itemCode: "F-AH-1", description: "IVORY", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 149 },
  { id: "rm-99", itemCode: "F-BO315-31", description: "METAL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 18 },
  { id: "rm-100", itemCode: "F-BO315-7", description: "PEACH", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 2 },
  { id: "rm-101", itemCode: "FC 22", description: "FOAM CUTTER 22MM", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 0 },
  { id: "rm-102", itemCode: "FG66151-02", description: "PICCO FG66151-02 (FABRIC)", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 42 },
  { id: "rm-103", itemCode: "FG66151-10", description: "PICCO FG66151-10 (FABRIC)", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 342 },
  { id: "rm-104", itemCode: "FG66151-15", description: "PICCO FG66151-15 (FABRIC)", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 95 },
  { id: "rm-105", itemCode: "FG6876-01", description: "FG6876-01 (FABRIC)", baseUOM: "METER", itemGroup: "B.M-FABR", isActive: true, balanceQty: 2 },
  { id: "rm-106", itemCode: "G GAS95G", description: "STORAGE BED HINGE (GAS LIFT 950N)", baseUOM: "SET", itemGroup: "B.MECHAN", isActive: true, balanceQty: 0 },
  { id: "rm-107", itemCode: "G M66", description: "AIR TACKER M66 MATTRESS CLIP FUN MADE IN TAIWAN", baseUOM: "UNIT", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 1 },
  { id: "rm-108", itemCode: "GB75.63.300(SH)", description: "NON WOVEN BLACK", baseUOM: "ROLL", itemGroup: "S-FABRIC", isActive: true, balanceQty: 15 },
  { id: "rm-109", itemCode: "GBEX 1010F", description: "AIR TACKER BEX 1010F - MADE IN TAIWAN", baseUOM: "UNIT", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 1 },
  { id: "rm-110", itemCode: "GBEX 16851/850", description: "AIR TACKER BEX 16851/850 MADE IN TAIWAN", baseUOM: "UNIT", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 1 },
  { id: "rm-111", itemCode: "GBEX 90/40", description: "AIR TACKER BEX 90/40", baseUOM: "UNIT", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 4 },
  { id: "rm-112", itemCode: "GD8371-02", description: "BEETEX FABRIC", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 52 },
  { id: "rm-113", itemCode: "GM 1022J", description: "AIR TACKER MEITE TA33A/1022J", baseUOM: "UNIT", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 1 },
  { id: "rm-114", itemCode: "GUSF 2312", description: "AIR TACKER UNICATCH USF 2312", baseUOM: "UNIT", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 8 },
  { id: "rm-115", itemCode: "IRON2.0", description: "IRON METAL 2.0 MM (500 M/1 ROLL)", baseUOM: "MTR", itemGroup: "S.WEBB", isActive: true, balanceQty: 1000 },
  { id: "rm-116", itemCode: "KEMPAS 1 X 2 X 3", description: "KEMPAS 1 X 2 X 3 ' UP TANALIZED", baseUOM: "TON", itemGroup: "WD STRIP", isActive: true, balanceQty: 14 },
  { id: "rm-117", itemCode: "KN 14", description: "C-KNIFE STAINLESS STEEL 14\"", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 1 },
  { id: "rm-118", itemCode: "KN 14M", description: "(M)KNIFE STAINLESS STEEL-WOOD HANDLE 14\"", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 2 },
  { id: "rm-119", itemCode: "KN390-1", description: "SOFA FABRIC KOONA VELVET PEARL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 443 },
  { id: "rm-120", itemCode: "KN390-13", description: "SOFA FABRIC KOONA VELVET SILVER", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 225 },
  { id: "rm-121", itemCode: "KN390-14", description: "SOFA FABRIC KOONA METAL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 267 },
  { id: "rm-122", itemCode: "KN390-15", description: "SOFA FABRIC KOONA DEEP GREY", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 60 },
  { id: "rm-123", itemCode: "KN390-2", description: "SOFA FABRIC KOONA VELVET SAND", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 282 },
  { id: "rm-124", itemCode: "KN390-3", description: "SOFA FABRIC KOONA VELVET FOSSIL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 66 },
  { id: "rm-125", itemCode: "KN390-5", description: "SOFA FABRIC KOONA VELVET TAN", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 18 },
  { id: "rm-126", itemCode: "KS-01 BABY WHITE", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 158 },
  { id: "rm-127", itemCode: "KS-02 BUTTER CREAM", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 85 },
  { id: "rm-128", itemCode: "KS-03 YELLOW PEPPER", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 40 },
  { id: "rm-129", itemCode: "KS-04 LEATHER TAN", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-130", itemCode: "KS-05 MID COFFEE", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 34 },
  { id: "rm-131", itemCode: "KS-06 TUMERIC BROWN", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 9 },
  { id: "rm-132", itemCode: "KS-07 WONDER GRAY", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-133", itemCode: "KS-08 SEA PINK", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 37 },
  { id: "rm-134", itemCode: "KS-09 ROMANCE ROSE", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 38 },
  { id: "rm-135", itemCode: "KS-10 SOFT LAVENDAR", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 13 },
  { id: "rm-136", itemCode: "KS-11 MAXI PURPLE", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 11 },
  { id: "rm-137", itemCode: "KS-12 CLASSIC DENIM", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 27 },
  { id: "rm-138", itemCode: "KS-13 TENDER TURQOISE", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-139", itemCode: "KS-14 RICH JADE", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-140", itemCode: "KS-15 COOL SILVER", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 35 },
  { id: "rm-141", itemCode: "KS-16 ICE STEEL", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 5 },
  { id: "rm-142", itemCode: "KS-17 ROCK GRANITE", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 7 },
  { id: "rm-143", itemCode: "KS-18 GRAPHITE STONE", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 6 },
  { id: "rm-144", itemCode: "KS-19 MORNING DAWN", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 15 },
  { id: "rm-145", itemCode: "LC5 (B)", description: "LONG CHAIN NYLON #5 BLACK/580", baseUOM: "MTR", itemGroup: "S-FABRIC", isActive: true, balanceQty: 200 },
  { id: "rm-146", itemCode: "LC5 (W)", description: "LONG CHAIN NYLON #5 WHITE/500", baseUOM: "MTR", itemGroup: "S-FABRIC", isActive: true, balanceQty: 400 },
  { id: "rm-147", itemCode: "M2402-1", description: "PEARL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 140 },
  { id: "rm-148", itemCode: "M2402-13", description: "FOREST", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 38 },
  { id: "rm-149", itemCode: "M2402-17", description: "SILVER", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 95 },
  { id: "rm-150", itemCode: "M2402-18", description: "LIGHT GREY", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 45 },
  { id: "rm-151", itemCode: "M2402-4", description: "SAND", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 109 },
  { id: "rm-152", itemCode: "M2402-5", description: "LIGHT BROWN", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 48 },
  { id: "rm-153", itemCode: "M2402-6", description: "FOSSIL", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 46 },
  { id: "rm-154", itemCode: "MED-PSF15.064HCS(A1)", description: "POLYESTER FIBER 15D X 64MM 10KG/BAG", baseUOM: "KG", itemGroup: "B.FILLER", isActive: true, balanceQty: 5090 },
  { id: "rm-155", itemCode: "MHW 1\" X 2\"", description: "MHW 1\" X 2\" X 3' UP TANALIZED", baseUOM: "TON", itemGroup: "WD STRIP", isActive: true, balanceQty: 56 },
  { id: "rm-156", itemCode: "ND 12", description: "STAINLESS STEEL NEEDLE 12\"", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 0 },
  { id: "rm-157", itemCode: "ND 8", description: "STAINLESS STEEL NEEDLE 8\"", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 0 },
  { id: "rm-158", itemCode: "NHL-NC36/50-1.5\"", description: "DARK PINK SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 43 },
  { id: "rm-159", itemCode: "NHL-NC36/50-3\"", description: "DARK PINK SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 98 },
  { id: "rm-160", itemCode: "NHL-NC36/60-3\"", description: "GREEN SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 34 },
  { id: "rm-161", itemCode: "NHL-NC42/40-3\"", description: "PURPLE SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 7 },
  { id: "rm-162", itemCode: "NHL-NC42/50-2.5\"", description: "YELLOW SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 8 },
  { id: "rm-163", itemCode: "NINJA 01", description: "FABRIC", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 106 },
  { id: "rm-164", itemCode: "NINJA 02", description: "FABRIC", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 164 },
  { id: "rm-165", itemCode: "NINJA 03", description: "FABRIC", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 48 },
  { id: "rm-166", itemCode: "NINJA 08", description: "FABRIC", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 57 },
  { id: "rm-167", itemCode: "NL 5/8", description: "NAIL LEG 5/8 ( 300PCS X 10 BAG)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 16800 },
  { id: "rm-168", itemCode: "NLY-160G POLY FIBRE", description: "160G POLYESTER FIBRE", baseUOM: "KGS", itemGroup: "B.FILLER", isActive: true, balanceQty: 89 },
  { id: "rm-169", itemCode: "NLY-D12-1\"", description: "WHITE SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 990 },
  { id: "rm-170", itemCode: "NLY-D12-1.5\"", description: "WHITE SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 15 },
  { id: "rm-171", itemCode: "NLY-D12-2\"", description: "WHITE SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 0 },
  { id: "rm-172", itemCode: "NLY-D12-6MM", description: "WHITE SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 2370 },
  { id: "rm-173", itemCode: "NLY-D16-2\"", description: "BLUE SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 90 },
  { id: "rm-174", itemCode: "NLY-D25-0.5\"", description: "DARK GREY SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 480 },
  { id: "rm-175", itemCode: "NLY-D25-1\"", description: "DARK GREY SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 60 },
  { id: "rm-176", itemCode: "NLY-D25-1.5\"", description: "DARK GREY SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 0 },
  { id: "rm-177", itemCode: "NLY-D25-3\"", description: "DARK GREY SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 21 },
  { id: "rm-178", itemCode: "NLY-D27-10MM", description: "L/PURPLE SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 0 },
  { id: "rm-179", itemCode: "NLY-D27-2\"", description: "L/PURPLE SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 30 },
  { id: "rm-180", itemCode: "NLY-D30-1\"", description: "YELLOW SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 0 },
  { id: "rm-181", itemCode: "NLY-D30-1.5\"", description: "YELLOW SPONGE", baseUOM: "PCS", itemGroup: "B.FILLER", isActive: true, balanceQty: 15 },
  { id: "rm-182", itemCode: "NLY-D32-1\"", description: "YELLOW SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 80 },
  { id: "rm-183", itemCode: "NLY-D35-2.5\"", description: "ORANGE SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 49 },
  { id: "rm-184", itemCode: "NLY-D35-3\"", description: "ORANGE SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 121 },
  { id: "rm-185", itemCode: "NLY-D36-2\"", description: "LIGHT GREY SOFT SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 0 },
  { id: "rm-186", itemCode: "NLY-D38-1.5\"", description: "LIGHT BLUE SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 30 },
  { id: "rm-187", itemCode: "NLY-D38-3\"", description: "LIGHT BLUE SPONGE", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 7 },
  { id: "rm-188", itemCode: "NV-1WP", description: "BEIGE", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 32 },
  { id: "rm-189", itemCode: "NW63X75(B)", description: "NON WOVEN 63\" X 75GM (BLACK) (250 METER)", baseUOM: "MTR", itemGroup: "S-FABRIC", isActive: true, balanceQty: 12250 },
  { id: "rm-190", itemCode: "OKE B", description: "OKE CLIP (BLACK) 100MM (1,500 PCS X 1 ROLL)", baseUOM: "PCS", itemGroup: "S.OTHERS", isActive: true, balanceQty: 4500 },
  { id: "rm-191", itemCode: "OPN-A ( 8KG X 5 ROLL)", description: "POLYESTER STAPLE FIBRE 7DLTSS (8KG X 5 ROLL)", baseUOM: "KG", itemGroup: "B.FILLER", isActive: true, balanceQty: 40 },
  { id: "rm-192", itemCode: "OPN-A (12KG X 10 ROLL)", description: "POLYESTER STAPLE FIBRE 7DLTSS ( 12KG X 10 ROLL)", baseUOM: "KG", itemGroup: "B.FILLER", isActive: true, balanceQty: 720 },
  { id: "rm-193", itemCode: "OPN-A (12KG X 5 BAG)", description: "POLYESTER STAPLE FIBRE 7DLTSS ( 12KG X 5 BAG)", baseUOM: "KG", itemGroup: "B.FILLER", isActive: true, balanceQty: 120 },
  { id: "rm-194", itemCode: "OPN-A (8KG X 1 ROLL)", description: "POLYESTER STAPLE FIBRE 7DLTSS (8 KG X 1 ROLL)", baseUOM: "KG", itemGroup: "B.FILLER", isActive: true, balanceQty: 8 },
  { id: "rm-195", itemCode: "OPN-A (8KG X 10 ROLL)", description: "POLYESTER STAPLE FIBRE 7DTLSS (8 KG X 10 ROLL)", baseUOM: "KG", itemGroup: "B.FILLER", isActive: true, balanceQty: 80 },
  { id: "rm-196", itemCode: "OPP80", description: "OPP TAPE 80YR (96 ROLL/1BOX)", baseUOM: "ROLL", itemGroup: "PACKING", isActive: true, balanceQty: 1344 },
  { id: "rm-197", itemCode: "ORION-01", description: "ORION-01", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 18 },
  { id: "rm-198", itemCode: "ORION-02", description: "ORION-02", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 2 },
  { id: "rm-199", itemCode: "ORION-5", description: "ORION-5", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 19 },
  { id: "rm-200", itemCode: "PB72", description: "PLASTIC LONG 72\" GRADE (B) TUBING", baseUOM: "KG", itemGroup: "PACKING", isActive: true, balanceQty: 417 },
  { id: "rm-201", itemCode: "PB72H", description: "PLASTIC LONG 72\" GRADE (B) TUBING - HOLE", baseUOM: "KG", itemGroup: "PACKING", isActive: true, balanceQty: 1603 },
  { id: "rm-202", itemCode: "PB86", description: "PLASTIC LONG 86\" X 0.07MM TUBING", baseUOM: "KG", itemGroup: "PACKING", isActive: true, balanceQty: 103 },
  { id: "rm-203", itemCode: "PB86H", description: "PLASTIC LONG 86\" X 0.07MM TUBING - HOLE", baseUOM: "KG", itemGroup: "PACKING", isActive: true, balanceQty: 1269 },
  { id: "rm-204", itemCode: "PBB70120", description: "PLASTIC BAG 70\" X 120\" GRADE (B) (25KG X 1BAG)", baseUOM: "KG", itemGroup: "PACKING", isActive: true, balanceQty: 275 },
  { id: "rm-205", itemCode: "PBB7096", description: "PLASTIC BAG 70\" X 96\" GRADE (B) (25KG X 1BAG)", baseUOM: "KG", itemGroup: "PACKING", isActive: true, balanceQty: 25 },
  { id: "rm-206", itemCode: "PC151-01", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 12030 },
  { id: "rm-207", itemCode: "PC151-02", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 2415 },
  { id: "rm-208", itemCode: "PC151-03", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 2393 },
  { id: "rm-209", itemCode: "PC151-04", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 495 },
  { id: "rm-210", itemCode: "PC151-05", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 50 },
  { id: "rm-211", itemCode: "PC151-06", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 149 },
  { id: "rm-212", itemCode: "PC151-07", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 55 },
  { id: "rm-213", itemCode: "PC151-08", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 43 },
  { id: "rm-214", itemCode: "PC151-09", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 221 },
  { id: "rm-215", itemCode: "PC151-10", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-216", itemCode: "PC151-11", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 432 },
  { id: "rm-217", itemCode: "PC151-12", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 305 },
  { id: "rm-218", itemCode: "PC151-13", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 1871 },
  { id: "rm-219", itemCode: "PC151-14", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 1390 },
  { id: "rm-220", itemCode: "PC151-15", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-221", itemCode: "PC151-16", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 102 },
  { id: "rm-222", itemCode: "PC151-17", description: "FABRIC", baseUOM: "ROLL", itemGroup: "B.M-FABR", isActive: true, balanceQty: 3098 },
  { id: "rm-223", itemCode: "PC151-18", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 1030 },
  { id: "rm-224", itemCode: "PESTO-PT004", description: "PESTO - OLIVE PT004-3 16. 5 M X 1", baseUOM: "MTR", itemGroup: "S.M-FABR", isActive: true, balanceQty: 16 },
  { id: "rm-225", itemCode: "PLY/C", description: "9MM 4\" X 8\" PLYWOOD COMM", baseUOM: "PCS", itemGroup: "PLYWOOD", isActive: true, balanceQty: 0 },
  { id: "rm-226", itemCode: "POLY (B)", description: "THREAD (WHITE) BUTTON - CHINA", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 0 },
  { id: "rm-227", itemCode: "POLY (F1)", description: "POLYESTER POLYFILL 230 80\" X 30M (1\") 1 ROLL = 16.6KG", baseUOM: "KG", itemGroup: "B.FILLER", isActive: true, balanceQty: 16 },
  { id: "rm-228", itemCode: "POLY (F1/2)", description: "POLYESTER POLYFILL 160 80\"X40M (1/2\") 1ROLL= 15.5 KG", baseUOM: "KG", itemGroup: "B.FILLER", isActive: true, balanceQty: 256 },
  { id: "rm-229", itemCode: "POLY 20MM(B)", description: "20MM WEAVING TAPE RAW (BLACK) (100 METER X 1 ROLL)", baseUOM: "MTR", itemGroup: "S-FABRIC", isActive: true, balanceQty: 1200 },
  { id: "rm-230", itemCode: "POLY(S)", description: "TKTI20 2PLY 400 GRAMS S.P.T WHITE / SMALL", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 15 },
  { id: "rm-231", itemCode: "POLYESTER FIBREFILL", description: "POLYESTER FIBREFILL SMA120G X 84\" X 60M X 20MM", baseUOM: "KG", itemGroup: "B.FILLER", isActive: true, balanceQty: 230 },
  { id: "rm-232", itemCode: "PS41463C", description: "C-POCKET SPRING(41CM X 46CM X 46CM X 7.5)3\" (15PCS X 1BAG)", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 225 },
  { id: "rm-233", itemCode: "PS4146NTC", description: "NTC-POCKET SPRING 41CM X 46CM X 10CM 4\" 6X7 2.0MM (15 PCS/1 BAG)", baseUOM: "PCS", itemGroup: "S.FILLER", isActive: true, balanceQty: 60 },
  { id: "rm-234", itemCode: "PSF0.9-051SS(L)", description: "0.9D X 51MM SS MICROFIBER 10KGS/BAG", baseUOM: "KG", itemGroup: "S.FILLER", isActive: true, balanceQty: 10 },
  { id: "rm-235", itemCode: "R.MERANTI F/J", description: "RED MERANTI FINGER JOINT 18MM X 43MM X 12FT", baseUOM: "PCS", itemGroup: "WD STRIP", isActive: true, balanceQty: 3730 },
  { id: "rm-236", itemCode: "RULER", description: "RULER WOOD", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 3 },
  { id: "rm-237", itemCode: "RULER L", description: "RULER PLASTIC 'L' SHAPE", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 1 },
  { id: "rm-238", itemCode: "SC 12", description: "SCISSORS 12\"", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 7 },
  { id: "rm-239", itemCode: "SC 7", description: "SCISSORS 7\"", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 2 },
  { id: "rm-240", itemCode: "SCRW 12X1", description: "SELF DRILLING SCREW #12 X 1\" (500 PCS X 1 BOX)", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 500 },
  { id: "rm-241", itemCode: "SCRW(M4X25)-R", description: "CHIP BOARD SCREWS (CSL) M4 X 25 (RB) (25,000 PCS/1 BOX)", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 50000 },
  { id: "rm-242", itemCode: "SCRW(M4X38)-R", description: "CHIP BOARD SCREWS (CSK) M4 X 38 (RB)", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 60000 },
  { id: "rm-243", itemCode: "SCRW(M4X50)-R", description: "CHIP BOARD SCREWS (CSK) M4 X 50 (RB) (8,000 PCS/1 BOX)", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 16000 },
  { id: "rm-244", itemCode: "SCRW12X50C", description: "SELF DRILLING SCREW #12 X 50MM", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 6000 },
  { id: "rm-245", itemCode: "SCRW625", description: "MACHINE S.B+MS M6 X25 ZY LOOSE 1/2 BOX = 2,000 PCS", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 2500 },
  { id: "rm-246", itemCode: "SCRW870J", description: "SCREW JCBB M8 X 70MM", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 0 },
  { id: "rm-247", itemCode: "SD Y", description: "SCREW DRIVER Y", baseUOM: "PCS", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 4 },
  { id: "rm-248", itemCode: "SG 1133", description: "SOFA GLUE 1133 A5-N (12KG)", baseUOM: "TIN", itemGroup: "B.OTHERS", isActive: true, balanceQty: 82 },
  { id: "rm-249", itemCode: "SGUN 827", description: "SPRAY GUN 827 2.0 MM (WHITE) WITH AIR CUP SET", baseUOM: "UNIT", itemGroup: "EQUIPMEN", isActive: true, balanceQty: 8 },
  { id: "rm-250", itemCode: "SHR H137E-T", description: "SOFA BLACK REST H137 EPOXY BLACK - T (10PCS X 1 BOX)", baseUOM: "PCS", itemGroup: "B.MECHAN", isActive: true, balanceQty: 260 },
  { id: "rm-251", itemCode: "SHR H139E", description: "SOFA BACK REST H139 EPOXY BLACK (10PCS X 1BOX)", baseUOM: "PCS", itemGroup: "S.MECH", isActive: true, balanceQty: 230 },
  { id: "rm-252", itemCode: "SL 102", description: "NO.102 SOFA PLASTIC LEG (OBLIQUE) 6\" BLACK *FLOPPY* (90 PCS X 1 BAG)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 450 },
  { id: "rm-253", itemCode: "SL 13.5(E)", description: "13.5 - SOFA LEG EPOXY H130 (100 PCS X 1 BOX)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 100 },
  { id: "rm-254", itemCode: "SL 156", description: "NO.156 CORNER PROTECTOR 40MM X 40MM X 40MM (6,600 PCS/ 1CTN)", baseUOM: "PCS", itemGroup: "PACKING", isActive: true, balanceQty: 6600 },
  { id: "rm-255", itemCode: "SL 157", description: "NO.157 CORNER PROTECTOR 75MM X 75MM X 75MM (1,600 PCS/ 1CTN)", baseUOM: "PCS", itemGroup: "PACKING", isActive: true, balanceQty: 41600 },
  { id: "rm-256", itemCode: "SL 26", description: "NO.26 SOFA LEG PLASTIC (ROUND) 1\"", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 5000 },
  { id: "rm-257", itemCode: "SL 27", description: "NO.27 SOFA LEG PLASTIC (ROUND) 2\"", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 5100 },
  { id: "rm-258", itemCode: "SL 38", description: "NO.38 SOFA PLASTIC LEG (SQUARE) 4\" (130PCS/2BAG)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 5720 },
  { id: "rm-259", itemCode: "SL B027", description: "SOFA EPOXY METAL LEG B027 180MM (50 PCS X 1 BOX )", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 440 },
  { id: "rm-260", itemCode: "SL B034B-7", description: "SOFA LEG 180-B034 (GUN BLACK) - 7\" (40 PCS X 1 BOX)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 280 },
  { id: "rm-261", itemCode: "SLA 120E", description: "SOFA LEG ADJUST (H120) 12 TO 21 EPOXY SPECIAL (100PCS X 1 BOX)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 300 },
  { id: "rm-262", itemCode: "SLA 95E", description: "SOFA METAL LEG ADJUST H95 EPOXY SPECIAL (100PCS X 1 BOX)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 100 },
  { id: "rm-263", itemCode: "SLA AL036", description: "SOFA LEG (EPOXY)AL 036/H150 X 1.5 MM (40PCS X 1 BOX)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 560 },
  { id: "rm-264", itemCode: "SLC 170A", description: "CENTER LEG KA 0216 H~170MM (BLACK) A (60 PCS X 1 BOX)", baseUOM: "PCS", itemGroup: "B.ACCE", isActive: true, balanceQty: 60 },
  { id: "rm-265", itemCode: "SLIDER-5 (S)", description: "PK SLIDER #5 (NICKER) (1,000 PCS/1 BOX)", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 2000 },
  { id: "rm-266", itemCode: "SOFA 5531", description: "1A(LHF) + 2A(RHF)", baseUOM: "SET", itemGroup: "S.OTHERS", isActive: true, balanceQty: -10 },
  { id: "rm-267", itemCode: "SOFA 5535", description: "5535 (3+L)", baseUOM: "UNIT", itemGroup: "B.M-FABR", isActive: true, balanceQty: -3 },
  { id: "rm-268", itemCode: "SQUARE PILLOW", description: "SQUARE PILLOW (16\" X 16\")", baseUOM: "UNIT", itemGroup: "B.M-FABR", isActive: true, balanceQty: -12 },
  { id: "rm-269", itemCode: "STAR 01", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 8 },
  { id: "rm-270", itemCode: "STAR 02", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 0 },
  { id: "rm-271", itemCode: "STAR 05", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 7 },
  { id: "rm-272", itemCode: "STAR 07", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 8 },
  { id: "rm-273", itemCode: "STAR 08", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 7 },
  { id: "rm-274", itemCode: "STAR 11", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 8 },
  { id: "rm-275", itemCode: "STAR 12", description: "FABRIC", baseUOM: "MTR", itemGroup: "B.M-FABR", isActive: true, balanceQty: 13 },
  { id: "rm-276", itemCode: "TN 8X10", description: "TEE NUT M8 X 10", baseUOM: "PCS", itemGroup: "B.OTHERS", isActive: true, balanceQty: 0 },
  { id: "rm-277", itemCode: "VT\"1 (B) HKL", description: "VELCO TAPE 1\" HOOK (BLACK) (25M)", baseUOM: "MTR", itemGroup: "B.OTHERS", isActive: true, balanceQty: 1250 },
  { id: "rm-278", itemCode: "VT\"1 (B) LP", description: "VELCO TAPE 1\" LOOP (BLACK) (25M)", baseUOM: "MTR", itemGroup: "B.OTHERS", isActive: true, balanceQty: 1250 },
  { id: "rm-279", itemCode: "WB ELASTIC", description: "ELASTIC WEBBING (WHITE) 10MM (288 YR/1 ROLL)", baseUOM: "ROLL", itemGroup: "B.OTHERS", isActive: true, balanceQty: 6 },
  { id: "rm-280", itemCode: "WB150", description: "WEBBING TAPE 150* (50 METER X 1 ROLL) (10 ROLL X 1 BOX)", baseUOM: "ROLL", itemGroup: "B.WEBB", isActive: true, balanceQty: 30 },
  { id: "rm-281", itemCode: "WB350A", description: "WEBBING TAPE 350-A (50 METER X 1 ROLL) GREEN (10 ROLL X 1 BOX)", baseUOM: "ROLL", itemGroup: "B.WEBB", isActive: true, balanceQty: 50 },
  { id: "rm-282", itemCode: "WB470 G", description: "WEBBING TAPE MLS 470 (50 METER X 1ROLL)( 1ROLL / 1 BOX)", baseUOM: "ROLL", itemGroup: "B.WEBB", isActive: true, balanceQty: 10 },
  { id: "rm-283", itemCode: "YL/KPS 1 X 2 X 3", description: "YL/KPS 1 X 2 X 3 ' UP TANALIZED", baseUOM: "TON", itemGroup: "WD STRIP", isActive: true, balanceQty: 8 },
  { id: "rm-284", itemCode: "ZS3.8", description: "ZIP ZAG SPRING 3.8 MM (40 KG X 1 BAG)", baseUOM: "KG", itemGroup: "S.WEBB", isActive: true, balanceQty: 240 },
  { id: "rm-285", itemCode: "ZS51", description: "ZIP ZAG SPRING 51 CM (500 PCS X 1 BAG)", baseUOM: "PCS", itemGroup: "S.WEBB", isActive: true, balanceQty: 1500 },
  { id: "rm-286", itemCode: "ZS53.5", description: "ZIP ZAG SPRING 53.5 CM (500 PCS X 1 BAG)", baseUOM: "PCS", itemGroup: "S.WEBB", isActive: true, balanceQty: 500 },
];

// --- Workers (matching Attendance sheet employees) ---
export const workers: Worker[] = [
  { id: "emp-1", empNo: "EMP-001", name: "EI PHOO WEI", departmentId: "dept-1", departmentCode: "FAB_CUT", position: "Worker", phone: "+60 12-111 0001", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2022-03-15", icNumber: "", passportNumber: "MA123456", nationality: "Myanmar" },
  { id: "emp-2", empNo: "EMP-002", name: "ZIN MIN NWE", departmentId: "dept-1", departmentCode: "FAB_CUT", position: "Worker", phone: "+60 12-111 0002", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2022-04-01", icNumber: "", passportNumber: "MA234567", nationality: "Myanmar" },
  { id: "emp-3", empNo: "EMP-003", name: "THI THI AYE", departmentId: "dept-1", departmentCode: "FAB_CUT", position: "Worker", phone: "+60 12-111 0003", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2022-05-10", icNumber: "", passportNumber: "MA345678", nationality: "Myanmar" },
  { id: "emp-4", empNo: "EMP-004", name: "ANN", departmentId: "dept-2", departmentCode: "FAB_SEW", position: "Worker", phone: "+60 12-111 0004", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2021-11-20", icNumber: "", passportNumber: "MA456789", nationality: "Myanmar" },
  { id: "emp-5", empNo: "EMP-005", name: "OO SAN YEE", departmentId: "dept-2", departmentCode: "FAB_SEW", position: "Worker", phone: "+60 12-111 0005", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2022-01-10", icNumber: "", passportNumber: "MA567890", nationality: "Myanmar" },
  { id: "emp-6", empNo: "EMP-006", name: "PHYU SIN MOE", departmentId: "dept-2", departmentCode: "FAB_SEW", position: "Worker", phone: "+60 12-111 0006", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2022-02-14", icNumber: "", passportNumber: "MA678901", nationality: "Myanmar" },
  { id: "emp-7", empNo: "EMP-007", name: "KHIN MAUNG LIN", departmentId: "dept-7", departmentCode: "UPHOLSTERY", position: "Senior Worker", phone: "+60 12-111 0007", status: "ACTIVE", basicSalarySen: 220000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2020-06-01", icNumber: "", passportNumber: "MA789012", nationality: "Myanmar" },
  { id: "emp-8", empNo: "EMP-008", name: "KYAW OO", departmentId: "dept-7", departmentCode: "UPHOLSTERY", position: "Worker", phone: "+60 12-111 0008", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2021-08-15", icNumber: "", passportNumber: "MA890123", nationality: "Myanmar" },
  { id: "emp-9", empNo: "EMP-009", name: "HLAING MIN AUNG", departmentId: "dept-5", departmentCode: "FRAMING", position: "Senior Worker", phone: "+60 12-111 0009", status: "ACTIVE", basicSalarySen: 220000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2020-03-10", icNumber: "", passportNumber: "MA901234", nationality: "Myanmar" },
  { id: "emp-10", empNo: "EMP-010", name: "ZAW MOE TUN", departmentId: "dept-5", departmentCode: "FRAMING", position: "Worker", phone: "+60 12-111 0010", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2021-09-22", icNumber: "", passportNumber: "MA012345", nationality: "Myanmar" },
  { id: "emp-11", empNo: "EMP-011", name: "YE LI SOE", departmentId: "dept-3", departmentCode: "WOOD_CUT", position: "Worker", phone: "+60 12-111 0011", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2022-06-05", icNumber: "", passportNumber: "MA112233", nationality: "Myanmar" },
  { id: "emp-12", empNo: "EMP-012", name: "KYAW ZIN OO", departmentId: "dept-4", departmentCode: "FOAM", position: "Worker", phone: "+60 12-111 0012", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2022-07-18", icNumber: "", passportNumber: "MA223344", nationality: "Myanmar" },
  { id: "emp-13", empNo: "EMP-013", name: "TUN TUN NAING", departmentId: "dept-6", departmentCode: "WEBBING", position: "Worker", phone: "+60 12-111 0013", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2021-12-01", icNumber: "", passportNumber: "MA334455", nationality: "Myanmar" },
  { id: "emp-14", empNo: "EMP-014", name: "AUNG THEIN WIN", departmentId: "dept-8", departmentCode: "PACKING", position: "Worker", phone: "+60 12-111 0014", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2023-01-09", icNumber: "", passportNumber: "MA445566", nationality: "Myanmar" },
  { id: "emp-15", empNo: "EMP-015", name: "MYINT AUNG", departmentId: "dept-8", departmentCode: "PACKING", position: "Worker", phone: "+60 12-111 0015", status: "ACTIVE", basicSalarySen: 180000, workingHoursPerDay: 9, workingDaysPerMonth: 26, joinDate: "2023-02-20", icNumber: "", passportNumber: "MA556677", nationality: "Myanmar" },
];

// ============================================================
// SALES ORDERS (matching Google Sheet Master Tracker)
// 1 SO = multiple items, each item becomes a production order line (-01, -02, etc.)
// ============================================================

export type SalesOrderItem = {
  id: string;
  lineNo: number; // 1, 2, 3...
  lineSuffix: string; // "-01", "-02" etc.
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: ItemCategory;
  sizeCode: string;
  sizeLabel: string;
  fabricId: string;
  fabricCode: string;
  quantity: number;
  // Customization (matching Google Sheet columns)
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string;
  specialOrderPriceSen: number;
  // Pricing
  basePriceSen: number;
  unitPriceSen: number; // base + divan + leg + special
  lineTotalSen: number;
  notes: string;
};

export type SalesOrder = {
  id: string;
  // Customer PO (from customer)
  customerPO: string;
  customerPOId: string; // e.g. PO-2603-104
  customerPODate: string;
  // Customer SO
  customerSO: string;
  customerSOId: string;
  // Reference
  reference: string;
  // Customer info
  customerId: string;
  customerName: string;
  customerState: string;
  // Optional delivery hub (branch). Added after the fact — not all rows carry it.
  hubId?: string | null;
  hubName?: string;
  // Company SO (HOOKKA's SO number)
  companySO: string;
  companySOId: string; // e.g. SO-2604-045
  companySODate: string;
  // Delivery
  customerDeliveryDate: string;
  hookkaExpectedDD: string;
  hookkaDeliveryOrder: string;
  // Items
  items: SalesOrderItem[];
  // Totals
  subtotalSen: number;
  totalSen: number;
  // Status
  status: SOStatus;
  preHoldStatus?: SOStatus; // saved before ON_HOLD so we can resume to correct state
  overdue: string; // "PENDING" | "OVERDUE" | "COMPLETED"
  notes: string;
  // Stock (make-to-stock) flag — set when the SO was generated from the
  // Production page as a placeholder for future customer demand. The
  // companySOId uses an "SOH-" prefix (e.g. SOH-2604-001) and the customer
  // fields are intentionally blank. When a real customer order lands, this
  // SO is renamed in-place to the customer SO number; the child PO /
  // jobCards keep their ids + progress so none of the production work
  // is lost in the swap. Optional so legacy rows default to false.
  isStock?: boolean;
  createdAt: string;
  updatedAt: string;
};

// --- Production Orders (matching department sheets) ---
export type JobCard = {
  id: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  sequence: number;
  status: JobCardStatus;
  dueDate: string;
  // WIP grouping — which sub-component this card belongs to.
  // "FG" means the L1 (finished-good level) card. Per-WIP cards carry the
  // WIP code/type/label so the dept dashboard can show e.g. a Divan row and
  // a Headboard row for the same PO landing in FRAMING.
  // Optional for backward-compat with legacy seed data — the dept dashboard
  // falls back to "FG" / product label when missing.
  wipKey?: string;       // stable id for unlock chains, e.g. "FG", "DIVAN", "HB", "BASE", "CUSHION", "ARM"
  wipCode?: string;      // e.g. "Divan Heights Queen"
  wipType?: string;      // WIPType discriminator
  wipLabel?: string;     // human label for table column, e.g. "Divan", "Headboard", "Sofa Base"
  // BOM-branch identifier (added 2026-04-27). Equals the top-level
  // wipComponent's wipCode that this JC's subtree descended from. Within
  // one wipKey, the BOM has parallel branches (e.g. BF Divan: "Foam"
  // branch and "Fabric" branch) that converge at UPHOLSTERY. Empty
  // string for joint terminals (UPH, PACK) which sit at the BOM root
  // and are shared by every branch. (wipKey, branchKey) is the correct
  // grouping key for lock + consume + WIP-display sibling lookups.
  branchKey?: string;
  // Effective quantity for THIS WIP on the parent PO. Computed at PO
  // generation time as `node.quantity × parentWipQty × item.quantity`.
  // Example: a bedframe SO line qty=1 with Divan BOM quantity=2 yields a
  // Divan job card with wipQty=2 (two divans need to be fabricated).
  // Falls back to the PO quantity when missing (legacy seed data).
  wipQty?: number;
  // Prerequisite department condition
  prerequisiteMet: boolean;
  // Worker assignment (PIC = Person In Charge)
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  // Timing
  completedDate: string | null;
  estMinutes: number;
  actualMinutes: number | null;
  // Category (CAT 1-6 from Google Sheet)
  category: string;
  productionTimeMinutes: number;
  // Overdue tracking
  overdue: string; // "COMPLETED" | "PENDING" | "3 DAYS OVERDUE" etc.
  // Per-card rack assignment. Set from the Packing dept grid so two WIPs
  // under the same SO/PO (e.g. a divan and its matching headboard) can land
  // on DIFFERENT racks. Falls back to the PO-level rackingNumber when unset.
  rackingNumber?: string;
  // Per-piece PIC tracking (B-flow sticker-binding FIFO).
  // Length == wipQty (falls back to parent PO.quantity). Each physical piece
  // has its own pic1/pic2 slots. The piece is lazily bound to a scanned
  // sticker on first scan via `boundStickerKey = "{scannedPoId}::{scannedJcId}::{pieceNo}"`.
  // Subsequent scans of the same sticker find the same target piecePic, so
  // two workers sharing one physical piece both land as pic1+pic2 of the
  // SAME piecePic (Q5). Third-worker attempts return PIC_FULL.
  // Legacy jc.pic1Id/pic2Id stays populated for A-flow compat + quick-look
  // in grids — it mirrors piecePics[0] when B-flow is active.
  piecePics?: PiecePic[];
};

/**
 * One physical piece's PIC slots. Part of JobCard.piecePics.
 *
 * `boundStickerKey` is set on the FIRST scan that routes a sticker here via
 * FIFO. Subsequent scans of that same sticker (by any worker) find this row
 * by key and share it, instead of running FIFO again and getting a different
 * target. This is what makes "two workers same Divan" work (Q5).
 */
export type PiecePic = {
  pieceNo: number;                  // 1-indexed within the JC
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  completedAt: string | null;       // ISO, set when pic1 first fills
  lastScanAt: string | null;        // ISO, per-piece 3s debounce
  boundStickerKey: string | null;   // "{poId}::{jcId}::{pieceNo}" of the sticker that claimed this slot
};

export type ProductionOrder = {
  id: string;
  poNo: string; // e.g. SO-2604-045-01 (from SO + line suffix)
  salesOrderId: string;
  salesOrderNo: string;
  lineNo: number;
  // Customer info
  customerPOId: string;
  customerReference: string;
  customerName: string;
  customerState: string;
  companySOId: string;
  // CO-origin POs (migration 0064): a PO can come from a Consignment Order
  // instead of a Sales Order. When the parent is a CO, salesOrderId / companySOId
  // are empty and these two fields carry the CO linkage. Mutex with SO.
  consignmentOrderId?: string;
  companyCOId?: string;
  // Product info
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: ItemCategory;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  // Customization
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string;
  notes: string;
  // Status
  status: ProductionStatus;
  currentDepartment: string; // department code
  progress: number; // 0-100
  // Department job cards (8 departments)
  jobCards: JobCard[];
  // Dates
  startDate: string;
  targetEndDate: string;
  completedDate: string | null;
  // Racking (from Packing department)
  rackingNumber: string;
  // Stock IN status
  stockedIn: boolean;
  createdAt: string;
  updatedAt: string;
};

// --- Delivery Orders ---
export type DeliveryOrderItem = {
  id: string;
  productionOrderId: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  itemM3: number;
  rackingNumber: string;
  packingStatus: string;
  salesOrderNo?: string;
};

export type DeliveryOrder = {
  id: string;
  doNo: string;
  salesOrderId: string;
  companySO: string;
  companySOId: string;
  // Customer info
  customerId: string;
  customerPOId: string;
  customerName: string;
  customerState: string;
  deliveryAddress: string;
  contactPerson: string;
  contactPhone: string;
  // Optional delivery hub (branch)
  hubId?: string | null;
  hubName?: string;
  // Optional 3PL / lorry dispatch fields
  dropPoints?: number;
  deliveryCostSen?: number;
  lorryId?: string | null;
  lorryName?: string;
  // Optional proof of delivery (set once SIGNED)
  proofOfDelivery?: ProofOfDelivery;
  // Dates
  deliveryDate: string;
  hookkaExpectedDD: string;
  // Driver
  driverId: string | null;
  driverName: string;
  vehicleNo: string;
  // Items
  items: DeliveryOrderItem[];
  // Totals
  totalM3: number;
  totalItems: number;
  // Status
  status: DeliveryStatus;
  overdue: string;
  // Tracking
  dispatchedAt: string | null;
  deliveredAt: string | null;
  remarks: string;
  createdAt: string;
  updatedAt: string;

  // ---------- B-flow extensions ----------
  // Master QR code printed on the DO header. Scanning it marks every
  // fgUnitIds entry as DELIVERED in one shot (customer sign-off).
  doQrCode?: string;
  // Explicit list of FGUnit ids this DO covers. A-flow uses `items` (by PO);
  // B-flow uses individual FG tracking so we list FGUnit ids directly.
  fgUnitIds?: string[];
  signedAt?: string | null;
  signedByWorkerId?: string | null;
  signedByWorkerName?: string | null;
};

// --- Invoice Types ---
export type InvoiceItem = {
  id: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
};

export type InvoicePayment = {
  id: string;
  date: string;
  amountSen: number;
  method: "CASH" | "CHEQUE" | "BANK_TRANSFER" | "CREDIT_CARD" | "E_WALLET";
  reference: string;
};

export type Invoice = {
  id: string;
  invoiceNo: string; // INV-YYMM-XXX
  deliveryOrderId: string;
  doNo: string;
  salesOrderId: string;
  companySOId: string;
  customerId: string;
  customerName: string;
  customerState: string;
  // Optional delivery hub (branch)
  hubId?: string | null;
  hubName?: string;
  items: InvoiceItem[];
  subtotalSen: number;
  totalSen: number;
  status: string; // DRAFT, SENT, PAID, PARTIAL_PAID, OVERDUE, CANCELLED
  invoiceDate: string;
  dueDate: string;
  paidAmount: number;
  paymentDate: string | null;
  paymentMethod: string;
  payments: InvoicePayment[];
  notes: string;
  createdAt: string;
  updatedAt: string;
};

// --- Attendance Records ---
export type AttendanceRecord = {
  id: string;
  employeeId: string;
  employeeName: string;
  departmentCode: string;
  departmentName: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  status: AttendanceStatus;
  workingMinutes: number;
  productionTimeMinutes: number;
  efficiencyPct: number;
  overtimeMinutes: number;
  // Breakdown by department (for cross-trained workers)
  deptBreakdown: { deptCode: string; minutes: number; productCode: string }[];
  notes: string;
};

// ============================================================
// MOCK DATA
// ============================================================

let _soSeq = 46;
export function getNextSONo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `SO-${yymm}-${String(_soSeq++).padStart(3, "0")}`;
}

let _doSeq = 19;
export function getNextDONo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `DO-${yymm}-${String(_doSeq++).padStart(3, "0")}`;
}

// Helper to create job cards for all 8 departments
export function createJobCards(dueDate: string, category: ItemCategory, estMinutesPerDept: number): JobCard[] {
  return departments.map((dept) => ({
    id: generateId(),
    departmentId: dept.id,
    departmentCode: dept.code,
    departmentName: dept.shortName,
    sequence: dept.sequence,
    status: "WAITING" as JobCardStatus,
    dueDate,
    prerequisiteMet: dept.sequence === 1,
    pic1Id: null,
    pic1Name: "",
    pic2Id: null,
    pic2Name: "",
    completedDate: null,
    estMinutes: estMinutesPerDept,
    actualMinutes: null,
    category: `CAT ${Math.min(dept.sequence, 4)}`,
    productionTimeMinutes: estMinutesPerDept,
    overdue: "PENDING",
  }));
}

// --- SALES ORDERS (matching Google Sheet Sales Order Details) ---
export const salesOrders: SalesOrder[] = [
  // ============================================================
  // DRAFT SOs — ready for review and confirmation
  // ============================================================
  {
    id: "so-draft-1",
    customerPO: "PO-008301", customerPOId: "PO-008301", customerPODate: "2026-04-15",
    customerSO: "SO-012001", customerSOId: "SO-012001", reference: "HC11001",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-001", companySOId: "SO-2604-001", companySODate: "2026-04-15",
    customerDeliveryDate: "2026-04-28", hookkaExpectedDD: "2026-04-26", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-draft-1a", lineNo: 1, lineSuffix: "-01", productId: "prod-6", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 2, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 112000, notes: "" },
      { id: "soi-draft-1b", lineNo: 2, lineSuffix: "-02", productId: "prod-39", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-10", fabricCode: "PC151-10", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
    ],
    subtotalSen: 157000, totalSen: 157000,
    status: "DRAFT", overdue: "PENDING", notes: "From PO-008301 (Houzs KL)",
    createdAt: "2026-04-15T10:00:00Z", updatedAt: "2026-04-15T10:00:00Z",
  },
  {
    id: "so-draft-2",
    customerPO: "PO-008305", customerPOId: "PO-008305", customerPODate: "2026-04-16",
    customerSO: "SO-012005", customerSOId: "SO-012005", reference: "HC11005",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-002", companySOId: "SO-2604-002", companySODate: "2026-04-16",
    customerDeliveryDate: "2026-04-30", hookkaExpectedDD: "2026-04-28", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-draft-2a", lineNo: 1, lineSuffix: "-01", productId: "prod-100", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-14", fabricCode: "PC151-14", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 5, legPriceSen: 5000, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
    ],
    subtotalSen: 85000, totalSen: 85000,
    status: "DRAFT", overdue: "PENDING", notes: "From PO-008305 (Houzs PG)",
    createdAt: "2026-04-16T09:00:00Z", updatedAt: "2026-04-16T09:00:00Z",
  },
  {
    id: "so-draft-3",
    customerPO: "PO/2604-201", customerPOId: "PO/2604-201", customerPODate: "2026-04-16",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-003", companySOId: "SO-2604-003", companySODate: "2026-04-16",
    customerDeliveryDate: "2026-05-05", hookkaExpectedDD: "2026-05-03", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-draft-3a", lineNo: 1, lineSuffix: "-01", productId: "prod-39", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-draft-3b", lineNo: 2, lineSuffix: "-02", productId: "prod-44", productCode: "1019(A)-(K)", productName: "1019(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 63000, unitPriceSen: 63000, lineTotalSen: 63000, notes: "" },
      { id: "soi-draft-3c", lineNo: 3, lineSuffix: "-03", productId: "prod-160", productCode: "5530-2S", productName: "5530-2S", itemCategory: "SOFA", sizeCode: "2S", sizeLabel: "2S", fabricId: "fab-KN390-2", fabricCode: "KN390-2", quantity: 1, gapInches: 0, divanHeightInches: 0, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 121700, unitPriceSen: 121700, lineTotalSen: 121700, notes: "Seat height: 28\"" },
    ],
    subtotalSen: 224700, totalSen: 224700,
    status: "DRAFT", overdue: "PENDING", notes: "From Carress PO/2604-201",
    createdAt: "2026-04-16T14:00:00Z", updatedAt: "2026-04-16T14:00:00Z",
  },
  // ============================================================
  // Imported from BF Master Tracker — 145 SOs / 229 items
  // ============================================================
  // SO-2603-226 / PO-008259 / Houzs PG
  {
    id: "so-bf-1",
    customerPO: "PO-008259", customerPOId: "PO-008259", customerPODate: "2026-03-31",
    customerSO: "SO-001171", customerSOId: "SO-001171", reference: "AKHC2055",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2603-226", companySOId: "SO-2603-226", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-06", hookkaExpectedDD: "2026-04-04", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-1", lineNo: 1, lineSuffix: "-01", productId: "prod-1009-A---Q-", productCode: "1009(A)-(Q)", productName: "1009(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-SF-AT-15", fabricCode: "SF-AT-15", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 0, unitPriceSen: 0, lineTotalSen: 0, notes: "" },
    ],
    subtotalSen: 0, totalSen: 0,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-214 / PO-008262 / Houzs KL
  {
    id: "so-bf-2",
    customerPO: "PO-008262", customerPOId: "PO-008262", customerPODate: "2026-03-31",
    customerSO: "SO-006581", customerSOId: "SO-006581", reference: "HC5441",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-214", companySOId: "SO-2603-214", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-15", hookkaExpectedDD: "2026-04-13", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-2", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-211 / PO-008265 / Houzs KL
  {
    id: "so-bf-3",
    customerPO: "PO-008265", customerPOId: "PO-008265", customerPODate: "2026-03-31",
    customerSO: "SO-009754", customerSOId: "SO-009754", reference: "HC10516",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-211", companySOId: "SO-2603-211", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-18", hookkaExpectedDD: "2026-04-16", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-3", lineNo: 1, lineSuffix: "-01", productId: "prod-2038-A---K-", productCode: "2038(A)-(K)", productName: "2038(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 68000, lineTotalSen: 68000, notes: "" },
      { id: "soi-bf-4", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 96000, totalSen: 96000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-210 / PO-008267 / Houzs KL
  {
    id: "so-bf-4",
    customerPO: "PO-008267", customerPOId: "PO-008267", customerPODate: "2026-03-31",
    customerSO: "SO-010897", customerSOId: "SO-010897", reference: "HC8900",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-210", companySOId: "SO-2603-210", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-15", hookkaExpectedDD: "2026-04-13", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-5", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "DIVAN CURVE", specialOrderPriceSen: 5000, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
    ],
    subtotalSen: 45000, totalSen: 45000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-225 / PO-008269 / Houzs KL
  {
    id: "so-bf-5",
    customerPO: "PO-008269", customerPOId: "PO-008269", customerPODate: "2026-03-31",
    customerSO: "SO-010989", customerSOId: "SO-010989", reference: "HC14203",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-225", companySOId: "SO-2603-225", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-18", hookkaExpectedDD: "2026-04-16", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-6", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-224 / PO-008270 / Houzs KL
  {
    id: "so-bf-6",
    customerPO: "PO-008270", customerPOId: "PO-008270", customerPODate: "2026-03-31",
    customerSO: "SO-011013", customerSOId: "SO-011013", reference: "HC14489",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-224", companySOId: "SO-2603-224", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-05-13", hookkaExpectedDD: "2026-05-11", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-7", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-223 / PO-008271 / Houzs KL
  {
    id: "so-bf-7",
    customerPO: "PO-008271", customerPOId: "PO-008271", customerPODate: "2026-03-31",
    customerSO: "SO-011063", customerSOId: "SO-011063", reference: "HC10176",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-223", companySOId: "SO-2603-223", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-17", hookkaExpectedDD: "2026-04-15", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-8", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---K-", productCode: "1003(A)-(K)", productName: "1003(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-10", fabricCode: "PC151-10", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 68000, lineTotalSen: 68000, notes: "" },
    ],
    subtotalSen: 68000, totalSen: 68000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-222 / PO-008272 / Houzs KL
  {
    id: "so-bf-8",
    customerPO: "PO-008272", customerPOId: "PO-008272", customerPODate: "2026-03-31",
    customerSO: "SO-011067", customerSOId: "SO-011067", reference: "HC10163",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-222", companySOId: "SO-2603-222", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-22", hookkaExpectedDD: "2026-04-20", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-9", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-13", fabricCode: "PC151-13", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "HB Fully Cover, Divan Top Fully Cover", specialOrderPriceSen: 10000, basePriceSen: 40000, unitPriceSen: 50000, lineTotalSen: 50000, notes: "" },
    ],
    subtotalSen: 50000, totalSen: 50000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-221 / PO-008273 / Houzs KL
  {
    id: "so-bf-9",
    customerPO: "PO-008273", customerPOId: "PO-008273", customerPODate: "2026-03-31",
    customerSO: "SO-011073", customerSOId: "SO-011073", reference: "HC10175",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-221", companySOId: "SO-2603-221", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-30", hookkaExpectedDD: "2026-04-28", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-10", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
    ],
    subtotalSen: 45000, totalSen: 45000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-220 / PO-008274 / Houzs KL
  {
    id: "so-bf-10",
    customerPO: "PO-008274", customerPOId: "PO-008274", customerPODate: "2026-03-31",
    customerSO: "SO-011078", customerSOId: "SO-011078", reference: "HC10547",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-220", companySOId: "SO-2603-220", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-18", hookkaExpectedDD: "2026-04-16", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-11", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-14", fabricCode: "PC151-14", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-219 / PO-008275 / Houzs KL
  {
    id: "so-bf-11",
    customerPO: "PO-008275", customerPOId: "PO-008275", customerPODate: "2026-03-31",
    customerSO: "SO-011079", customerSOId: "SO-011079", reference: "HC14253",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-219", companySOId: "SO-2603-219", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-16", hookkaExpectedDD: "2026-04-14", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-12", lineNo: 1, lineSuffix: "-01", productId: "prod-2006-A---K-", productCode: "2006(A)-(K)", productName: "2006(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 67000, unitPriceSen: 67000, lineTotalSen: 67000, notes: "" },
    ],
    subtotalSen: 67000, totalSen: 67000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-218 / PO-008276 / Houzs KL
  {
    id: "so-bf-12",
    customerPO: "PO-008276", customerPOId: "PO-008276", customerPODate: "2026-03-31",
    customerSO: "SO-011081", customerSOId: "SO-011081", reference: "HC14254",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-218", companySOId: "SO-2603-218", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-15", hookkaExpectedDD: "2026-04-13", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-13", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-14", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-15", lineNo: 3, lineSuffix: "-03", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 108000, totalSen: 108000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-215 / PO-008260 / Houzs PG
  {
    id: "so-bf-13",
    customerPO: "PO-008260", customerPOId: "PO-008260", customerPODate: "2026-03-31",
    customerSO: "SO-002326", customerSOId: "SO-002326", reference: "DLPG1973",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2603-215", companySOId: "SO-2603-215", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-18", hookkaExpectedDD: "2026-04-16", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-16", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
    ],
    subtotalSen: 85000, totalSen: 85000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-213 / PO-008263 / Houzs KL
  {
    id: "so-bf-14",
    customerPO: "PO-008263", customerPOId: "PO-008263", customerPODate: "2026-03-31",
    customerSO: "SO-006950", customerSOId: "SO-006950", reference: "HC5990",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-213", companySOId: "SO-2603-213", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-18", hookkaExpectedDD: "2026-04-16", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-17", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-209 / PO-008268 / Houzs KL
  {
    id: "so-bf-15",
    customerPO: "PO-008268", customerPOId: "PO-008268", customerPODate: "2026-03-31",
    customerSO: "SO-010988", customerSOId: "SO-010988", reference: "HC14162",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-209", companySOId: "SO-2603-209", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-18", hookkaExpectedDD: "2026-04-16", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-18", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 7, legPriceSen: 16000, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 96000, lineTotalSen: 96000, notes: "" },
    ],
    subtotalSen: 96000, totalSen: 96000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-216 / PO-008277 / Houzs KL
  {
    id: "so-bf-16",
    customerPO: "PO-008277", customerPOId: "PO-008277", customerPODate: "2026-03-31",
    customerSO: "SO-011085", customerSOId: "SO-011085", reference: "HC14256",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-216", companySOId: "SO-2603-216", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-15", hookkaExpectedDD: "2026-04-13", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-19", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-18", fabricCode: "PC151-18", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-31T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2512-368 / EXPO-006950 / Houzs PG
  {
    id: "so-bf-17",
    customerPO: "EXPO-006950", customerPOId: "EXPO-006950", customerPODate: "2025-12-20",
    customerSO: "SO-009015", customerSOId: "SO-009015", reference: "HC10093",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2512-368", companySOId: "SO-2512-368", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-08", hookkaExpectedDD: "2026-04-06", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-20", lineNo: 1, lineSuffix: "-01", productId: "prod-2038-A---Q-", productCode: "2038(A)-(Q)", productName: "2038(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "Right Drawer", specialOrderPriceSen: 15000, basePriceSen: 56000, unitPriceSen: 76000, lineTotalSen: 76000, notes: "" },
      { id: "soi-bf-21", lineNo: 2, lineSuffix: "-02", productId: "prod-1005--S-", productCode: "1005-(S)", productName: "1005-(S)", itemCategory: "BEDFRAME", sizeCode: "S", sizeLabel: "3FT", fabricId: "fab-PC151-09", fabricCode: "PC151-09", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 38000, unitPriceSen: 38000, lineTotalSen: 38000, notes: "" },
    ],
    subtotalSen: 114000, totalSen: 114000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2025-12-20T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2602-065 / EXPO-007834 / Houzs KL
  {
    id: "so-bf-18",
    customerPO: "EXPO-007834", customerPOId: "EXPO-007834", customerPODate: "2026-02-11",
    customerSO: "SO-009836", customerSOId: "SO-009836", reference: "HC9936",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2602-065", companySOId: "SO-2602-065", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-08", hookkaExpectedDD: "2026-04-06", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-22", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "Right Drawer", specialOrderPriceSen: 15000, basePriceSen: 40000, unitPriceSen: 60000, lineTotalSen: 60000, notes: "" },
    ],
    subtotalSen: 60000, totalSen: 60000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-02-11T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2602-040 / EXPO-007805 / Houzs KL
  {
    id: "so-bf-19",
    customerPO: "EXPO-007805", customerPOId: "EXPO-007805", customerPODate: "2026-02-09",
    customerSO: "SO-009835", customerSOId: "SO-009835", reference: "HC9932",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2602-040", companySOId: "SO-2602-040", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-07", hookkaExpectedDD: "2026-04-05", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-23", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-02-09T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-140 / SKYLINE A30-07 / The Conts
  {
    id: "so-bf-20",
    customerPO: "SKYLINE A30-07", customerPOId: "SKYLINE A30-07", customerPODate: "2026-04-07",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-3", customerName: "The Conts", customerState: "KL",
    companySO: "SO-2604-140", companySOId: "SO-2604-140", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-24", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-25", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-26", lineNo: 3, lineSuffix: "-03", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 84000, totalSen: 84000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-153 / PO-2604-031 / Carress
  {
    id: "so-bf-21",
    customerPO: "PO-2604-031", customerPOId: "PO-2604-031", customerPODate: "2026-04-07",
    customerSO: "", customerSOId: "", reference: "DL0566",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-153", companySOId: "SO-2604-153", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-25", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-27", lineNo: 1, lineSuffix: "-01", productId: "prod-1005--K-", productCode: "1005-(K)", productName: "1005-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 52000, totalSen: 52000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-154 / PO--2604-033 / Carress
  {
    id: "so-bf-22",
    customerPO: "PO--2604-033", customerPOId: "PO--2604-033", customerPODate: "2026-04-07",
    customerSO: "", customerSOId: "", reference: "CR0963",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-154", companySOId: "SO-2604-154", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-09", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-28", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 16, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-147 / PO-008347 / Houzs PG
  {
    id: "so-bf-23",
    customerPO: "PO-008347", customerPOId: "PO-008347", customerPODate: "2026-04-06",
    customerSO: "SO-006338", customerSOId: "SO-006338", reference: "AKHC8077",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-147", companySOId: "SO-2604-147", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-28", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-29", lineNo: 1, lineSuffix: "-01", productId: "prod-DIVAN--K-", productCode: "DIVAN-(K)", productName: "DIVAN-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-03", fabricCode: "PC151-03", quantity: 1, gapInches: null, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 42000, unitPriceSen: 42000, lineTotalSen: 42000, notes: "" },
    ],
    subtotalSen: 42000, totalSen: 42000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-06T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-148 / PO-008348 / Houzs KL
  {
    id: "so-bf-24",
    customerPO: "PO-008348", customerPOId: "PO-008348", customerPODate: "2026-04-06",
    customerSO: "SO-007364", customerSOId: "SO-007364", reference: "HC7901",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-148", companySOId: "SO-2604-148", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-05-02", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-30", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-03", fabricCode: "PC151-03", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-06T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-149 / PO-008349 / Houzs PG
  {
    id: "so-bf-25",
    customerPO: "PO-008349", customerPOId: "PO-008349", customerPODate: "2026-04-06",
    customerSO: "SO-007567", customerSOId: "SO-007567", reference: "CR0308",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-149", companySOId: "SO-2604-149", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-05-02", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-31", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 9, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "Left Drawer, Right Drawer", specialOrderPriceSen: 30000, basePriceSen: 52000, unitPriceSen: 87000, lineTotalSen: 87000, notes: "" },
    ],
    subtotalSen: 87000, totalSen: 87000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-06T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-150 / PO-008350 / Houzs PG
  {
    id: "so-bf-26",
    customerPO: "PO-008350", customerPOId: "PO-008350", customerPODate: "2026-04-06",
    customerSO: "SO-009774", customerSOId: "SO-009774", reference: "HC10133",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-150", companySOId: "SO-2604-150", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-27", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-32", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "Right Drawer", specialOrderPriceSen: 15000, basePriceSen: 80000, unitPriceSen: 95000, lineTotalSen: 95000, notes: "" },
    ],
    subtotalSen: 95000, totalSen: 95000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-06T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-151 / PO-008351 / Houzs KL
  {
    id: "so-bf-27",
    customerPO: "PO-008351", customerPOId: "PO-008351", customerPODate: "2026-04-06",
    customerSO: "SO-010732", customerSOId: "SO-010732", reference: "HC12426",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-151", companySOId: "SO-2604-151", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-21", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-33", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-10", fabricCode: "PC151-10", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-06T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-152 / PO-008353 / Houzs PG
  {
    id: "so-bf-28",
    customerPO: "PO-008353", customerPOId: "PO-008353", customerPODate: "2026-04-06",
    customerSO: "SO-003901", customerSOId: "SO-003901", reference: "HC5050",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-152", companySOId: "SO-2604-152", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-34", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
      { id: "soi-bf-35", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 120000, totalSen: 120000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-06T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-201 / KAIA A21-05 / The Conts
  {
    id: "so-bf-29",
    customerPO: "KAIA A21-05", customerPOId: "KAIA A21-05", customerPODate: "2026-03-30",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-3", customerName: "The Conts", customerState: "KL",
    companySO: "SO-2603-201", companySOId: "SO-2603-201", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-06", hookkaExpectedDD: "2026-04-04", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-36", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-30T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-199 / PO-2603-112 / Carress
  {
    id: "so-bf-30",
    customerPO: "PO-2603-112", customerPOId: "PO-2603-112", customerPODate: "2026-03-30",
    customerSO: "", customerSOId: "", reference: "DL0555",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2603-199", companySOId: "SO-2603-199", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-07", hookkaExpectedDD: "2026-04-05", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-37", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-18", fabricCode: "PC151-18", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 52000, totalSen: 52000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-30T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-196 / PO-2603-100 / Carress
  {
    id: "so-bf-31",
    customerPO: "PO-2603-100", customerPOId: "PO-2603-100", customerPODate: "2026-03-30",
    customerSO: "", customerSOId: "", reference: "CR0934",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2603-196", companySOId: "SO-2603-196", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-13", hookkaExpectedDD: "2026-04-11", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-38", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-30T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-197 / PO-2603-102 / Carress
  {
    id: "so-bf-32",
    customerPO: "PO-2603-102", customerPOId: "PO-2603-102", customerPODate: "2026-03-30",
    customerSO: "", customerSOId: "", reference: "CR0933",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2603-197", companySOId: "SO-2603-197", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-18", hookkaExpectedDD: "2026-04-16", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-39", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-40", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
      { id: "soi-bf-41", lineNo: 3, lineSuffix: "-03", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 172000, totalSen: 172000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-30T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-198 / PO-2603-109 / Carress
  {
    id: "so-bf-33",
    customerPO: "PO-2603-109", customerPOId: "PO-2603-109", customerPODate: "2026-03-30",
    customerSO: "", customerSOId: "", reference: "CR0938",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2603-198", companySOId: "SO-2603-198", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "2026-04-18", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-42", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--SS-", productCode: "1013-(SS)", productName: "1013-(SS)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "3.5FT", fabricId: "fab-PC151-09", fabricCode: "PC151-09", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 27000, unitPriceSen: 27000, lineTotalSen: 27000, notes: "" },
      { id: "soi-bf-43", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-08", fabricCode: "PC151-08", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-44", lineNo: 3, lineSuffix: "-03", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 95000, totalSen: 95000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-30T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-200 / PO-2603-115 / Carress
  {
    id: "so-bf-34",
    customerPO: "PO-2603-115", customerPOId: "PO-2603-115", customerPODate: "2026-03-30",
    customerSO: "", customerSOId: "", reference: "DL0558",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2603-200", companySOId: "SO-2603-200", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-01", hookkaExpectedDD: "2026-03-30", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-45", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-30T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-190 / PO-008235 / Houzs KL
  {
    id: "so-bf-35",
    customerPO: "PO-008235", customerPOId: "PO-008235", customerPODate: "2026-03-28",
    customerSO: "SO-010936", customerSOId: "SO-010936", reference: "HC12436",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-190", companySOId: "SO-2603-190", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-11", hookkaExpectedDD: "2026-04-09", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-46", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-28T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-191 / PO-008236 / Houzs KL
  {
    id: "so-bf-36",
    customerPO: "PO-008236", customerPOId: "PO-008236", customerPODate: "2026-03-28",
    customerSO: "SO-010935", customerSOId: "SO-010935", reference: "HC12435",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-191", companySOId: "SO-2603-191", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-11", hookkaExpectedDD: "2026-04-09", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-47", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 33000, lineTotalSen: 33000, notes: "" },
    ],
    subtotalSen: 33000, totalSen: 33000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-28T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-192 / PO-008237 / Houzs KL
  {
    id: "so-bf-37",
    customerPO: "PO-008237", customerPOId: "PO-008237", customerPODate: "2026-03-28",
    customerSO: "SO-011006", customerSOId: "SO-011006", reference: "HC14208",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-192", companySOId: "SO-2603-192", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-13", hookkaExpectedDD: "2026-04-11", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-48", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
    ],
    subtotalSen: 85000, totalSen: 85000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-28T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-193 / PO-008238 / Houzs KL
  {
    id: "so-bf-38",
    customerPO: "PO-008238", customerPOId: "PO-008238", customerPODate: "2026-03-28",
    customerSO: "SO-011010", customerSOId: "SO-011010", reference: "HC14490",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-193", companySOId: "SO-2603-193", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-13", hookkaExpectedDD: "2026-04-11", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-49", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-28T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-188 / PO-008233 / Houzs KL
  {
    id: "so-bf-39",
    customerPO: "PO-008233", customerPOId: "PO-008233", customerPODate: "2026-03-28",
    customerSO: "SO-008355", customerSOId: "SO-008355", reference: "HC12233",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-188", companySOId: "SO-2603-188", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-11", hookkaExpectedDD: "2026-04-09", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-50", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-51", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-11", fabricCode: "PC151-11", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-28T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603--187 / PO-008232 / Houzs KL
  {
    id: "so-bf-40",
    customerPO: "PO-008232", customerPOId: "PO-008232", customerPODate: "2026-03-28",
    customerSO: "SO-007339", customerSOId: "SO-007339", reference: "HC6725",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603--187", companySOId: "SO-2603--187", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-15", hookkaExpectedDD: "2026-04-13", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-52", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-28T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-189 / PO-008234 / Houzs KL
  {
    id: "so-bf-41",
    customerPO: "PO-008234", customerPOId: "PO-008234", customerPODate: "2026-03-28",
    customerSO: "SO-010842", customerSOId: "SO-010842", reference: "HC8896",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-189", companySOId: "SO-2603-189", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-14", hookkaExpectedDD: "2026-04-12", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-53", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-13", fabricCode: "PC151-13", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-54", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-13", fabricCode: "PC151-13", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-28T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-194 / PO-008239 / Houzs KL
  {
    id: "so-bf-42",
    customerPO: "PO-008239", customerPOId: "PO-008239", customerPODate: "2026-03-28",
    customerSO: "SO-011012", customerSOId: "SO-011012", reference: "HC14072",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-194", companySOId: "SO-2603-194", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "2026-04-18", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-55", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-28T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-195 / PO-008240 / Houzs KL
  {
    id: "so-bf-43",
    customerPO: "PO-008240", customerPOId: "PO-008240", customerPODate: "2026-03-28",
    customerSO: "SO-007423", customerSOId: "SO-007423", reference: "HC7842",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-195", companySOId: "SO-2603-195", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-28", hookkaExpectedDD: "2026-04-26", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-56", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
      { id: "soi-bf-57", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 120000, totalSen: 120000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-28T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-181 / PO-008199 / Houzs SRW
  {
    id: "so-bf-44",
    customerPO: "PO-008199", customerPOId: "PO-008199", customerPODate: "2026-03-26",
    customerSO: "SO-007925", customerSOId: "SO-007925", reference: "HC8791",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2603-181", companySOId: "SO-2603-181", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-30", hookkaExpectedDD: "2026-04-28", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-58", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
      { id: "soi-bf-59", lineNo: 2, lineSuffix: "-02", productId: "prod-1005--Q-", productCode: "1005-(Q)", productName: "1005-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
    ],
    subtotalSen: 130000, totalSen: 130000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-26T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-182 / PO-008202 / Houzs KL
  {
    id: "so-bf-45",
    customerPO: "PO-008202", customerPOId: "PO-008202", customerPODate: "2026-03-26",
    customerSO: "SO-010963", customerSOId: "SO-010963", reference: "EGT0538",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-182", companySOId: "SO-2603-182", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-14", hookkaExpectedDD: "2026-04-12", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-60", lineNo: 1, lineSuffix: "-01", productId: "prod-2023--HF--W---S-", productCode: "2023-(HF)(W)-(S)", productName: "2023-(HF)(W)-(S)", itemCategory: "BEDFRAME", sizeCode: "S", sizeLabel: "3FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 61000, lineTotalSen: 61000, notes: "" },
    ],
    subtotalSen: 61000, totalSen: 61000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-26T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-183 / PO-008203 / Houzs KL
  {
    id: "so-bf-46",
    customerPO: "PO-008203", customerPOId: "PO-008203", customerPODate: "2026-03-26",
    customerSO: "SO-010966", customerSOId: "SO-010966", reference: "HC10542",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-183", companySOId: "SO-2603-183", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-10", hookkaExpectedDD: "2026-04-08", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-61", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---Q-", productCode: "2009(A)-(Q)", productName: "2009(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 70000, unitPriceSen: 70000, lineTotalSen: 70000, notes: "" },
    ],
    subtotalSen: 70000, totalSen: 70000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-26T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-184 / PO-008204 / Houzs KL
  {
    id: "so-bf-47",
    customerPO: "PO-008204", customerPOId: "PO-008204", customerPODate: "2026-03-26",
    customerSO: "SO-010971", customerSOId: "SO-010971", reference: "HC14154",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-184", companySOId: "SO-2603-184", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-17", hookkaExpectedDD: "2026-04-15", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-62", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---Q-", productCode: "2008(A)-(Q)", productName: "2008(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "Front Drawer", specialOrderPriceSen: 12000, basePriceSen: 70000, unitPriceSen: 82000, lineTotalSen: 82000, notes: "" },
      { id: "soi-bf-63", lineNo: 2, lineSuffix: "-02", productId: "prod-2038-A---Q-", productCode: "2038(A)-(Q)", productName: "2038(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 138000, totalSen: 138000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-26T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-185 / PO-008206 / Houzs KL
  {
    id: "so-bf-48",
    customerPO: "PO-008206", customerPOId: "PO-008206", customerPODate: "2026-03-26",
    customerSO: "SO-010982", customerSOId: "SO-010982", reference: "HC14061",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-185", companySOId: "SO-2603-185", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-02", hookkaExpectedDD: "2026-03-31", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-64", lineNo: 1, lineSuffix: "-01", productId: "prod-2006-A---K-", productCode: "2006(A)-(K)", productName: "2006(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 67000, unitPriceSen: 67000, lineTotalSen: 67000, notes: "" },
    ],
    subtotalSen: 67000, totalSen: 67000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-26T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-186 / PO-008208 / Houzs KL
  {
    id: "so-bf-49",
    customerPO: "PO-008208", customerPOId: "PO-008208", customerPODate: "2026-03-26",
    customerSO: "SO-010242", customerSOId: "SO-010242", reference: "HC10476",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-186", companySOId: "SO-2603-186", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-08", hookkaExpectedDD: "2026-04-06", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-65", lineNo: 1, lineSuffix: "-01", productId: "prod-2006-A---Q-", productCode: "2006(A)-(Q)", productName: "2006(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 55000, unitPriceSen: 55000, lineTotalSen: 55000, notes: "" },
    ],
    subtotalSen: 55000, totalSen: 55000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-26T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-156 / PO-008149 / Houzs PG
  {
    id: "so-bf-50",
    customerPO: "PO-008149", customerPOId: "PO-008149", customerPODate: "2026-03-25",
    customerSO: "SO-009979", customerSOId: "SO-009979", reference: "PG10168",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2603-156", companySOId: "SO-2603-156", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-10", hookkaExpectedDD: "2026-04-08", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-66", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: null, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-157 / PO-008153 / Houzs KL
  {
    id: "so-bf-51",
    customerPO: "PO-008153", customerPOId: "PO-008153", customerPODate: "2026-03-25",
    customerSO: "SO-010861", customerSOId: "SO-010861", reference: "HC12415",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-157", companySOId: "SO-2603-157", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-08", hookkaExpectedDD: "2026-04-06", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-67", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---K-", productCode: "1003(A)-(K)", productName: "1003(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 68000, lineTotalSen: 68000, notes: "" },
      { id: "soi-bf-68", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-69", lineNo: 3, lineSuffix: "-03", productId: "prod-DIVAN--Q-", productCode: "DIVAN-(Q)", productName: "DIVAN-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: null, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 30000, unitPriceSen: 30000, lineTotalSen: 30000, notes: "" },
      { id: "soi-bf-70", lineNo: 4, lineSuffix: "-04", productId: "prod-1003-A--HF--W---K-", productCode: "1003(A)(HF)(W)-(K)", productName: "1003(A)(HF)(W)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 68000, lineTotalSen: 68000, notes: "" },
    ],
    subtotalSen: 206000, totalSen: 206000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-159 / PO-008154 / Houzs PG
  {
    id: "so-bf-52",
    customerPO: "PO-008154", customerPOId: "PO-008154", customerPODate: "2026-03-25",
    customerSO: "SO-010862", customerSOId: "SO-010862", reference: "PG10183",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2603-159", companySOId: "SO-2603-159", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-10", hookkaExpectedDD: "2026-04-08", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-71", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-KS-15 COOL SILVER", fabricCode: "KS-15 COOL SILVER", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-160 / PO-008155 / Houzs KL
  {
    id: "so-bf-53",
    customerPO: "PO-008155", customerPOId: "PO-008155", customerPODate: "2026-03-25",
    customerSO: "SO-010864", customerSOId: "SO-010864", reference: "PG10865",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-160", companySOId: "SO-2603-160", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-13", hookkaExpectedDD: "2026-04-11", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-72", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 6, legPriceSen: 10000, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 50000, lineTotalSen: 50000, notes: "" },
    ],
    subtotalSen: 50000, totalSen: 50000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-161 / PO-008157 / Houzs KL
  {
    id: "so-bf-54",
    customerPO: "PO-008157", customerPOId: "PO-008157", customerPODate: "2026-03-25",
    customerSO: "SO-010867", customerSOId: "SO-010867", reference: "HC8869",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-161", companySOId: "SO-2603-161", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-09", hookkaExpectedDD: "2026-04-07", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-73", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
    ],
    subtotalSen: 45000, totalSen: 45000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-162 / PO-008159 / Houzs PG
  {
    id: "so-bf-55",
    customerPO: "PO-008159", customerPOId: "PO-008159", customerPODate: "2026-03-25",
    customerSO: "SO-010874", customerSOId: "SO-010874", reference: "PG10867",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2603-162", companySOId: "SO-2603-162", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-03", hookkaExpectedDD: "2026-04-01", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-74", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-03", fabricCode: "PC151-03", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-167 / PO-008165 / Houzs KL
  {
    id: "so-bf-56",
    customerPO: "PO-008165", customerPOId: "PO-008165", customerPODate: "2026-03-25",
    customerSO: "SO-010932", customerSOId: "SO-010932", reference: "HC14069",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-167", companySOId: "SO-2603-167", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-09", hookkaExpectedDD: "2026-04-07", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-75", lineNo: 1, lineSuffix: "-01", productId: "prod-2038-A---SS-", productCode: "2038(A)-(SS)", productName: "2038(A)-(SS)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "3.5FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 53000, unitPriceSen: 53000, lineTotalSen: 53000, notes: "" },
    ],
    subtotalSen: 53000, totalSen: 53000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-003 / PO-008174 / Houzs KL
  {
    id: "so-bf-57",
    customerPO: "PO-008174", customerPOId: "PO-008174", customerPODate: "2026-03-25",
    customerSO: "SO-010933", customerSOId: "SO-010933", reference: "HC14066",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-003", companySOId: "SO-2604-003", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-09", hookkaExpectedDD: "2026-04-07", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-76", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
    ],
    subtotalSen: 85000, totalSen: 85000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-177 / PO-008146 / Houzs PG
  {
    id: "so-bf-58",
    customerPO: "PO-008146", customerPOId: "PO-008146", customerPODate: "2026-03-25",
    customerSO: "SO-008167", customerSOId: "SO-008167", reference: "HC9255",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2603-177", companySOId: "SO-2603-177", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-10", hookkaExpectedDD: "2026-04-08", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-77", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-09", fabricCode: "PC151-09", quantity: 1, gapInches: 10, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
    ],
    subtotalSen: 45000, totalSen: 45000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-154 / PO-008147 / Houzs KL
  {
    id: "so-bf-59",
    customerPO: "PO-008147", customerPOId: "PO-008147", customerPODate: "2026-03-25",
    customerSO: "SO-008296", customerSOId: "SO-008296", reference: "HC12238",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-154", companySOId: "SO-2603-154", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-06", hookkaExpectedDD: "2026-04-04", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-78", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-15", fabricCode: "PC151-15", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-155 / PO-008148 / Houzs KL
  {
    id: "so-bf-60",
    customerPO: "PO-008148", customerPOId: "PO-008148", customerPODate: "2026-03-25",
    customerSO: "SO-009702", customerSOId: "SO-009702", reference: "HC10378",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-155", companySOId: "SO-2603-155", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-17", hookkaExpectedDD: "2026-04-15", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-79", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---K-", productCode: "1003(A)-(K)", productName: "1003(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "Right Drawer, Left Drawer", specialOrderPriceSen: 30000, basePriceSen: 68000, unitPriceSen: 98000, lineTotalSen: 98000, notes: "" },
      { id: "soi-bf-80", lineNo: 2, lineSuffix: "-02", productId: "prod-2006-A---Q-", productCode: "2006(A)-(Q)", productName: "2006(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "Left Drawer", specialOrderPriceSen: 15000, basePriceSen: 55000, unitPriceSen: 70000, lineTotalSen: 70000, notes: "" },
      { id: "soi-bf-81", lineNo: 3, lineSuffix: "-03", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "Front Drawer", specialOrderPriceSen: 12000, basePriceSen: 40000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 220000, totalSen: 220000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-163 / PO-008160 / Houzs KL
  {
    id: "so-bf-61",
    customerPO: "PO-008160", customerPOId: "PO-008160", customerPODate: "2026-03-25",
    customerSO: "SO-010887", customerSOId: "SO-010887", reference: "HC10162",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-163", companySOId: "SO-2603-163", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-14", hookkaExpectedDD: "2026-04-12", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-82", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-164 / PO-008161 / Houzs KL
  {
    id: "so-bf-62",
    customerPO: "PO-008161", customerPOId: "PO-008161", customerPODate: "2026-03-25",
    customerSO: "SO-010889", customerSOId: "SO-010889", reference: "HC9641",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-164", companySOId: "SO-2603-164", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-14", hookkaExpectedDD: "2026-04-12", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-83", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-165 / PO-008162 / Houzs KL
  {
    id: "so-bf-63",
    customerPO: "PO-008162", customerPOId: "PO-008162", customerPODate: "2026-03-25",
    customerSO: "SO-010906", customerSOId: "SO-010906", reference: "EGT0532",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-165", companySOId: "SO-2603-165", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-16", hookkaExpectedDD: "2026-04-14", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-84", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-14", fabricCode: "PC151-14", quantity: 1, gapInches: 16, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
      { id: "soi-bf-85", lineNo: 2, lineSuffix: "-02", productId: "prod-1019-A---HF---W---K-", productCode: "1019(A) (HF) (W)-(K)", productName: "1019(A) (HF) (W)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-18", fabricCode: "PC151-18", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 67000, unitPriceSen: 72000, lineTotalSen: 72000, notes: "" },
    ],
    subtotalSen: 157000, totalSen: 157000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-166 / PO-008163 / Houzs KL
  {
    id: "so-bf-64",
    customerPO: "PO-008163", customerPOId: "PO-008163", customerPODate: "2026-03-25",
    customerSO: "SO-010931", customerSOId: "SO-010931", reference: "HC14166",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-166", companySOId: "SO-2603-166", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-11", hookkaExpectedDD: "2026-04-09", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-86", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-10", fabricCode: "PC151-10", quantity: 1, gapInches: 10, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 57000, lineTotalSen: 57000, notes: "" },
    ],
    subtotalSen: 57000, totalSen: 57000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-168 / PO-008166 / Houzs KL
  {
    id: "so-bf-65",
    customerPO: "PO-008166", customerPOId: "PO-008166", customerPODate: "2026-03-25",
    customerSO: "SO-010937", customerSOId: "SO-010937", reference: "EGT0464",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-168", companySOId: "SO-2603-168", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-06", hookkaExpectedDD: "2026-04-04", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-87", lineNo: 1, lineSuffix: "-01", productId: "prod-2033--HF--W---K-", productCode: "2033 (HF)(W)-(K)", productName: "2033 (HF)(W)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 12, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "Left Drawer, Right Drawer", specialOrderPriceSen: 30000, basePriceSen: 70000, unitPriceSen: 105000, lineTotalSen: 105000, notes: "" },
    ],
    subtotalSen: 105000, totalSen: 105000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-169 / PO-008167 / Houzs KL
  {
    id: "so-bf-66",
    customerPO: "PO-008167", customerPOId: "PO-008167", customerPODate: "2026-03-25",
    customerSO: "SO-010938", customerSOId: "SO-010938", reference: "EGT0468",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-169", companySOId: "SO-2603-169", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-11", hookkaExpectedDD: "2026-04-09", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-88", lineNo: 1, lineSuffix: "-01", productId: "prod-2023--HF--W---K-", productCode: "2023 (HF)(W)-(K)", productName: "2023 (HF)(W)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-18", fabricCode: "PC151-18", quantity: 1, gapInches: null, divanHeightInches: null, divanPriceSen: 0, legHeightInches: null, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 70000, unitPriceSen: 70000, lineTotalSen: 70000, notes: "" },
    ],
    subtotalSen: 70000, totalSen: 70000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-170 / PO-008168 / Houzs KL
  {
    id: "so-bf-67",
    customerPO: "PO-008168", customerPOId: "PO-008168", customerPODate: "2026-03-25",
    customerSO: "SO-010951", customerSOId: "SO-010951", reference: "HC14491",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-170", companySOId: "SO-2603-170", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "2026-04-18", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-89", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-171 / PO-008169 / Houzs KL
  {
    id: "so-bf-68",
    customerPO: "PO-008169", customerPOId: "PO-008169", customerPODate: "2026-03-25",
    customerSO: "SO-009445", customerSOId: "SO-009445", reference: "HC9920",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-171", companySOId: "SO-2603-171", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "2026-04-18", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-90", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
      { id: "soi-bf-91", lineNo: 2, lineSuffix: "-02", productId: "prod-2038-A---Q-", productCode: "2038(A)-(Q)", productName: "2038(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 136000, totalSen: 136000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-173 / PO-008173 / Houzs KL
  {
    id: "so-bf-69",
    customerPO: "PO-008173", customerPOId: "PO-008173", customerPODate: "2026-03-25",
    customerSO: "SO-010929", customerSOId: "SO-010929", reference: "HC14158",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-173", companySOId: "SO-2603-173", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-14", hookkaExpectedDD: "2026-04-12", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-92", lineNo: 1, lineSuffix: "-01", productId: "prod-2038-A---Q-", productCode: "2038(A)-(Q)", productName: "2038(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
      { id: "soi-bf-93", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--SS-", productCode: "1007-(SS)", productName: "1007-(SS)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "3.5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 39000, unitPriceSen: 39000, lineTotalSen: 39000, notes: "" },
    ],
    subtotalSen: 95000, totalSen: 95000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-175 / PO-008175 / Houzs KL
  {
    id: "so-bf-70",
    customerPO: "PO-008175", customerPOId: "PO-008175", customerPODate: "2026-03-25",
    customerSO: "SO-010957", customerSOId: "SO-010957", reference: "EGT0461",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2603-175", companySOId: "SO-2603-175", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-13", hookkaExpectedDD: "2026-04-11", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-94", lineNo: 1, lineSuffix: "-01", productId: "prod-2038-A---HF---W---Q-", productCode: "2038(A) (HF) (W)-(Q)", productName: "2038(A) (HF) (W)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-179 / SKELINE A13-03 / The Conts
  {
    id: "so-bf-71",
    customerPO: "SKELINE A13-03", customerPOId: "SKELINE A13-03", customerPODate: "2026-03-25",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-3", customerName: "The Conts", customerState: "KL",
    companySO: "SO-2603-179", companySOId: "SO-2603-179", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-10", hookkaExpectedDD: "2026-04-08", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-95", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-96", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-97", lineNo: 3, lineSuffix: "-03", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 84000, totalSen: 84000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-180 / SKELINE A18-11 / The Conts
  {
    id: "so-bf-72",
    customerPO: "SKELINE A18-11", customerPOId: "SKELINE A18-11", customerPODate: "2026-03-25",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-3", customerName: "The Conts", customerState: "KL",
    companySO: "SO-2603-180", companySOId: "SO-2603-180", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-10", hookkaExpectedDD: "2026-04-08", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-98", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-99", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-100", lineNo: 3, lineSuffix: "-03", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 84000, totalSen: 84000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-178 / SKELINE A40-08 / The Conts
  {
    id: "so-bf-73",
    customerPO: "SKELINE A40-08", customerPOId: "SKELINE A40-08", customerPODate: "2026-03-25",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-3", customerName: "The Conts", customerState: "KL",
    companySO: "SO-2603-178", companySOId: "SO-2603-178", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-06", hookkaExpectedDD: "2026-04-04", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-101", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-102", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-103", lineNo: 3, lineSuffix: "-03", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 84000, totalSen: 84000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-25T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-153 / PO-008145 / Houzs PG
  {
    id: "so-bf-74",
    customerPO: "PO-008145", customerPOId: "PO-008145", customerPODate: "2026-03-24",
    customerSO: "SO-006566", customerSOId: "SO-006566", reference: "PG10278",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2603-153", companySOId: "SO-2603-153", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-15", hookkaExpectedDD: "2026-04-13", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-104", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-10", fabricCode: "PC151-10", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-24T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2603-127 / PO-008093 / Houzs PG
  {
    id: "so-bf-75",
    customerPO: "PO-008093", customerPOId: "PO-008093", customerPODate: "2026-03-17",
    customerSO: "SO-010795", customerSOId: "SO-010795", reference: "PG10861",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2603-127", companySOId: "SO-2603-127", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-01", hookkaExpectedDD: "2026-03-30", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-105", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-14", fabricCode: "PC151-14", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-03-17T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-016 / PO-008339 / Houzs KL
  {
    id: "so-bf-76",
    customerPO: "PO-008339", customerPOId: "PO-008339", customerPODate: "2026-04-03",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-016", companySOId: "SO-2604-016", companySODate: "2026-04-06",
    customerDeliveryDate: "2026-04-06", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-106", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
      { id: "soi-bf-107", lineNo: 2, lineSuffix: "-02", productId: "prod-1005--Q-", productCode: "1005-(Q)", productName: "1005-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
      { id: "soi-bf-108", lineNo: 3, lineSuffix: "-03", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
    ],
    subtotalSen: 175000, totalSen: 175000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-015 / PO-008346 / Houzs KL
  {
    id: "so-bf-77",
    customerPO: "PO-008346", customerPOId: "PO-008346", customerPODate: "2026-04-03",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-015", companySOId: "SO-2604-015", companySODate: "2026-04-06",
    customerDeliveryDate: "2026-04-08", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-109", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
      { id: "soi-bf-110", lineNo: 2, lineSuffix: "-02", productId: "prod-DIVAN--K-", productCode: "DIVAN-(K)", productName: "DIVAN-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: null, divanHeightInches: 4, divanPriceSen: 0, legHeightInches: 7, legPriceSen: 16000, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 42000, unitPriceSen: 58000, lineTotalSen: 58000, notes: "" },
      { id: "soi-bf-111", lineNo: 3, lineSuffix: "-03", productId: "prod-2038-A---Q-", productCode: "2038(A)-(Q)", productName: "2038(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 61000, lineTotalSen: 61000, notes: "" },
      { id: "soi-bf-112", lineNo: 4, lineSuffix: "-04", productId: "prod-1005--Q-", productCode: "1005-(Q)", productName: "1005-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
      { id: "soi-bf-113", lineNo: 5, lineSuffix: "-05", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 61000, lineTotalSen: 61000, notes: "" },
      { id: "soi-bf-114", lineNo: 6, lineSuffix: "-06", productId: "prod-2006-A---Q-", productCode: "2006(A)-(Q)", productName: "2006(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 55000, unitPriceSen: 60000, lineTotalSen: 60000, notes: "" },
      { id: "soi-bf-115", lineNo: 7, lineSuffix: "-07", productId: "prod-1041--Q-", productCode: "1041-(Q)", productName: "1041-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 37500, unitPriceSen: 42500, lineTotalSen: 42500, notes: "" },
      { id: "soi-bf-116", lineNo: 8, lineSuffix: "-08", productId: "prod-DIVAN--K-", productCode: "DIVAN-(K)", productName: "DIVAN-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: null, divanHeightInches: 4, divanPriceSen: 0, legHeightInches: 7, legPriceSen: 16000, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 42000, unitPriceSen: 58000, lineTotalSen: 58000, notes: "" },
      { id: "soi-bf-117", lineNo: 9, lineSuffix: "-09", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
    ],
    subtotalSen: 515500, totalSen: 515500,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-020 / PO-2604-008 / Carress
  {
    id: "so-bf-78",
    customerPO: "PO-2604-008", customerPOId: "PO-2604-008", customerPODate: "2026-04-03",
    customerSO: "", customerSOId: "", reference: "CR1022",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-020", companySOId: "SO-2604-020", companySODate: "2026-04-06",
    customerDeliveryDate: "2026-04-18", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-118", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-019 / PO-2604-012 / Carress
  {
    id: "so-bf-79",
    customerPO: "PO-2604-012", customerPOId: "PO-2604-012", customerPODate: "2026-04-03",
    customerSO: "", customerSOId: "", reference: "CDL0549",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-019", companySOId: "SO-2604-019", companySODate: "2026-04-06",
    customerDeliveryDate: "2026-04-14", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-119", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-18", fabricCode: "PC151-18", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-018 / PO-2604-014 / Carress
  {
    id: "so-bf-80",
    customerPO: "PO-2604-014", customerPOId: "PO-2604-014", customerPODate: "2026-04-03",
    customerSO: "", customerSOId: "", reference: "DL0560",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-018", companySOId: "SO-2604-018", companySODate: "2026-04-06",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-120", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-14", fabricCode: "PC151-14", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-121", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-14", fabricCode: "PC151-14", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-017 / PO-2604-017 / Carress
  {
    id: "so-bf-81",
    customerPO: "PO-2604-017", customerPOId: "PO-2604-017", customerPODate: "2026-04-03",
    customerSO: "", customerSOId: "", reference: "CR0943",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-017", companySOId: "SO-2604-017", companySODate: "2026-04-06",
    customerDeliveryDate: "2026-04-13", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-122", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-18", fabricCode: "PC151-18", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-141 / PO-008340 / Houzs SRW
  {
    id: "so-bf-82",
    customerPO: "PO-008340", customerPOId: "PO-008340", customerPODate: "2026-04-03",
    customerSO: "SO-006642", customerSOId: "SO-006642", reference: "HC7505",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2604-141", companySOId: "SO-2604-141", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-05-02", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-123", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-09", fabricCode: "PC151-09", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-124", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-15", fabricCode: "PC151-15", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-125", lineNo: 3, lineSuffix: "-03", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-15", fabricCode: "PC151-15", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 96000, totalSen: 96000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-142 / PO-008341 / Houzs KL
  {
    id: "so-bf-83",
    customerPO: "PO-008341", customerPOId: "PO-008341", customerPODate: "2026-04-03",
    customerSO: "SO-008416", customerSOId: "SO-008416", reference: "HC12288",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-142", companySOId: "SO-2604-142", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-126", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---K-", productCode: "1003(A)-(K)", productName: "1003(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 73000, lineTotalSen: 73000, notes: "" },
    ],
    subtotalSen: 73000, totalSen: 73000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-143 / PO-008342 / Houzs KL
  {
    id: "so-bf-84",
    customerPO: "PO-008342", customerPOId: "PO-008342", customerPODate: "2026-04-03",
    customerSO: "SO-010467", customerSOId: "SO-010467", reference: "HC10627",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-143", companySOId: "SO-2604-143", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-30", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-127", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-04", fabricCode: "PC151-04", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
      { id: "soi-bf-128", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-04", fabricCode: "PC151-04", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 108000, totalSen: 108000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-144 / PO-008343 / Houzs KL
  {
    id: "so-bf-85",
    customerPO: "PO-008343", customerPOId: "PO-008343", customerPODate: "2026-04-03",
    customerSO: "SO-010759", customerSOId: "SO-010759", reference: "HC12419",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-144", companySOId: "SO-2604-144", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-21", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-129", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-14", fabricCode: "PC151-14", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 52000, totalSen: 52000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-145 / PO-008344 / Houzs KL
  {
    id: "so-bf-86",
    customerPO: "PO-008344", customerPOId: "PO-008344", customerPODate: "2026-04-03",
    customerSO: "SO-011062", customerSOId: "SO-011062", reference: "HC10181",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-145", companySOId: "SO-2604-145", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-130", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-10", fabricCode: "PC151-10", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-146 / PO-008345 / Houzs KL
  {
    id: "so-bf-87",
    customerPO: "PO-008345", customerPOId: "PO-008345", customerPODate: "2026-04-03",
    customerSO: "SO-011124", customerSOId: "SO-011124", reference: "HC10544",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-146", companySOId: "SO-2604-146", companySODate: "2026-04-07",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-131", lineNo: 1, lineSuffix: "-01", productId: "prod-1005--K-", productCode: "1005-(K)", productName: "1005-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-03", fabricCode: "PC151-03", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
      { id: "soi-bf-132", lineNo: 2, lineSuffix: "-02", productId: "prod-1005--Q-", productCode: "1005-(Q)", productName: "1005-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-11", fabricCode: "PC151-11", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-133", lineNo: 3, lineSuffix: "-03", productId: "prod-1005--Q-", productCode: "1005-(Q)", productName: "1005-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 132000, totalSen: 132000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-078 / PO-008303 / Houzs KL
  {
    id: "so-bf-88",
    customerPO: "PO-008303", customerPOId: "PO-008303", customerPODate: "2026-04-02",
    customerSO: "SO-008423", customerSOId: "SO-008423", reference: "HC12327",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-078", companySOId: "SO-2604-078", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "2026-04-18", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-134", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
      { id: "soi-bf-135", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 57000, lineTotalSen: 57000, notes: "" },
    ],
    subtotalSen: 102000, totalSen: 102000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-072 / PO-008320 / Houzs KL
  {
    id: "so-bf-89",
    customerPO: "PO-008320", customerPOId: "PO-008320", customerPODate: "2026-04-02",
    customerSO: "SO-010848", customerSOId: "SO-010848", reference: "HC8880",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-072", companySOId: "SO-2604-072", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-15", hookkaExpectedDD: "2026-04-13", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-136", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 52000, totalSen: 52000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-073 / PO-008321 / Houzs KL
  {
    id: "so-bf-90",
    customerPO: "PO-008321", customerPOId: "PO-008321", customerPODate: "2026-04-02",
    customerSO: "SO-010912", customerSOId: "SO-010912", reference: "HC12431",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-073", companySOId: "SO-2604-073", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-27", hookkaExpectedDD: "2026-04-25", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-137", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-074 / PO-008322 / Houzs KL
  {
    id: "so-bf-91",
    customerPO: "PO-008322", customerPOId: "PO-008322", customerPODate: "2026-04-02",
    customerSO: "SO-010972", customerSOId: "SO-010972", reference: "HC14156",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-074", companySOId: "SO-2604-074", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "2026-04-22", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-138", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-076 / PO-008324 / Houzs KL
  {
    id: "so-bf-92",
    customerPO: "PO-008324", customerPOId: "PO-008324", customerPODate: "2026-04-02",
    customerSO: "SO-011122", customerSOId: "SO-011122", reference: "HC10593",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-076", companySOId: "SO-2604-076", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-27", hookkaExpectedDD: "2026-04-25", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-139", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---Q-", productCode: "2008(A)-(Q)", productName: "2008(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 70000, unitPriceSen: 70000, lineTotalSen: 70000, notes: "" },
      { id: "soi-bf-140", lineNo: 2, lineSuffix: "-02", productId: "prod-1005--SS-", productCode: "1005-(SS)", productName: "1005-(SS)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "3.5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 39000, unitPriceSen: 39000, lineTotalSen: 39000, notes: "" },
    ],
    subtotalSen: 109000, totalSen: 109000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-071 / PO-008319 / Houzs KL
  {
    id: "so-bf-93",
    customerPO: "PO-008319", customerPOId: "PO-008319", customerPODate: "2026-04-02",
    customerSO: "SO-009350", customerSOId: "SO-009350", reference: "HC9889",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-071", companySOId: "SO-2604-071", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-05-11", hookkaExpectedDD: "2026-05-09", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-141", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---Q-", productCode: "2008(A)-(Q)", productName: "2008(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 70000, unitPriceSen: 70000, lineTotalSen: 70000, notes: "" },
    ],
    subtotalSen: 70000, totalSen: 70000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-075 / PO-008323 / Houzs KL
  {
    id: "so-bf-94",
    customerPO: "PO-008323", customerPOId: "PO-008323", customerPODate: "2026-04-02",
    customerSO: "SO-011020", customerSOId: "SO-011020", reference: "HC10173",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-075", companySOId: "SO-2604-075", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "2026-04-22", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-142", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---K-", productCode: "1003(A)-(K)", productName: "1003(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 11, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 68000, lineTotalSen: 68000, notes: "" },
    ],
    subtotalSen: 68000, totalSen: 68000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-077 / PO-008325 / Houzs KL
  {
    id: "so-bf-95",
    customerPO: "PO-008325", customerPOId: "PO-008325", customerPODate: "2026-04-02",
    customerSO: "SO-011121", customerSOId: "SO-011121", reference: "HC12631",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-077", companySOId: "SO-2604-077", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-09", hookkaExpectedDD: "2026-04-07", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-143", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-04", fabricCode: "PC151-04", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-079 / PO-008304 / Houzs KL
  {
    id: "so-bf-96",
    customerPO: "PO-008304", customerPOId: "PO-008304", customerPODate: "2026-04-02",
    customerSO: "SO-009227", customerSOId: "SO-009227", reference: "HC10557",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-079", companySOId: "SO-2604-079", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-22", hookkaExpectedDD: "2026-04-20", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-144", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
      { id: "soi-bf-145", lineNo: 2, lineSuffix: "-02", productId: "prod-2008-A---Q-", productCode: "2008(A)-(Q)", productName: "2008(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 70000, unitPriceSen: 70000, lineTotalSen: 70000, notes: "" },
      { id: "soi-bf-146", lineNo: 3, lineSuffix: "-03", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
      { id: "soi-bf-147", lineNo: 4, lineSuffix: "-04", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-148", lineNo: 5, lineSuffix: "-05", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 322000, totalSen: 322000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-080 / PO-008305 / Houzs KL
  {
    id: "so-bf-97",
    customerPO: "PO-008305", customerPOId: "PO-008305", customerPODate: "2026-04-02",
    customerSO: "SO-009250", customerSOId: "SO-009250", reference: "HC9824",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-080", companySOId: "SO-2604-080", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-15", hookkaExpectedDD: "2026-04-13", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-149", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
      { id: "soi-bf-150", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "HB Fully Cover, Divan Top Fully Cover, Divan Bottom Fully Cover", specialOrderPriceSen: 10000, basePriceSen: 28000, unitPriceSen: 38000, lineTotalSen: 38000, notes: "" },
      { id: "soi-bf-151", lineNo: 3, lineSuffix: "-03", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "HB Fully Cover, Divan Top Fully Cover, Divan Bottom Fully Cover", specialOrderPriceSen: 10000, basePriceSen: 28000, unitPriceSen: 38000, lineTotalSen: 38000, notes: "" },
    ],
    subtotalSen: 156000, totalSen: 156000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-081 / PO-008306 / Houzs KL
  {
    id: "so-bf-98",
    customerPO: "PO-008306", customerPOId: "PO-008306", customerPODate: "2026-04-02",
    customerSO: "SO-009348", customerSOId: "SO-009348", reference: "HC10513",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-081", companySOId: "SO-2604-081", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-30", hookkaExpectedDD: "2026-04-28", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-152", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "HB Fully Cover, Divan Bottom Fully Cover", specialOrderPriceSen: 13000, basePriceSen: 80000, unitPriceSen: 93000, lineTotalSen: 93000, notes: "" },
      { id: "soi-bf-153", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "Divan Top Fully Cover, HB Fully Cover, Divan Bottom Fully Cover", specialOrderPriceSen: 10000, basePriceSen: 28000, unitPriceSen: 38000, lineTotalSen: 38000, notes: "" },
    ],
    subtotalSen: 131000, totalSen: 131000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-082 / PO-008307 / Houzs KL
  {
    id: "so-bf-99",
    customerPO: "PO-008307", customerPOId: "PO-008307", customerPODate: "2026-04-02",
    customerSO: "SO-011111", customerSOId: "SO-011111", reference: "HC14177",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-082", companySOId: "SO-2604-082", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-23", hookkaExpectedDD: "2026-04-21", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-154", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-11", fabricCode: "PC151-11", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-155", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-12", fabricCode: "PC151-12", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-02T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-070 / PO-2604-004 / Carress
  {
    id: "so-bf-100",
    customerPO: "PO-2604-004", customerPOId: "PO-2604-004", customerPODate: "2026-04-01",
    customerSO: "", customerSOId: "", reference: "DL0562",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-070", companySOId: "SO-2604-070", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-19", hookkaExpectedDD: "2026-04-17", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-156", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--S-", productCode: "1013-(S)", productName: "1013-(S)", itemCategory: "BEDFRAME", sizeCode: "S", sizeLabel: "3FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 26000, unitPriceSen: 26000, lineTotalSen: 26000, notes: "" },
      { id: "soi-bf-157", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 54000, totalSen: 54000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-01T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-068 / PO-2604-002 / Carress
  {
    id: "so-bf-101",
    customerPO: "PO-2604-002", customerPOId: "PO-2604-002", customerPODate: "2026-04-01",
    customerSO: "", customerSOId: "", reference: "DL0561",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-068", companySOId: "SO-2604-068", companySODate: "2026-04-03",
    customerDeliveryDate: "2026-04-07", hookkaExpectedDD: "2026-04-05", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-158", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-12", fabricCode: "PC151-12", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-159", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-12", fabricCode: "PC151-12", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-01T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-155 / PO-008376 / Houzs PG
  {
    id: "so-bf-102",
    customerPO: "PO-008376", customerPOId: "PO-008376", customerPODate: "2026-04-07",
    customerSO: "SO-006545", customerSOId: "SO-006545", reference: "PG10060",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-155", companySOId: "SO-2604-155", companySODate: "2026-04-09",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "2026-04-22", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-160", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-156 / PO-008377 / Houzs SBH
  {
    id: "so-bf-103",
    customerPO: "PO-008377", customerPOId: "PO-008377", customerPODate: "2026-04-07",
    customerSO: "SO-008860", customerSOId: "SO-008860", reference: "HC1284",
    customerId: "cust-1", customerName: "Houzs SBH", customerState: "KL",
    companySO: "SO-2604-156", companySOId: "SO-2604-156", companySODate: "2026-04-09",
    customerDeliveryDate: "2026-04-28", hookkaExpectedDD: "2026-04-26", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-161", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-14", fabricCode: "PC151-14", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
      { id: "soi-bf-162", lineNo: 2, lineSuffix: "-02", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-06", fabricCode: "PC151-06", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
      { id: "soi-bf-163", lineNo: 3, lineSuffix: "-03", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-13", fabricCode: "PC151-13", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 61000, lineTotalSen: 61000, notes: "" },
    ],
    subtotalSen: 202000, totalSen: 202000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-157 / PO-008378 / Houzs KL
  {
    id: "so-bf-104",
    customerPO: "PO-008378", customerPOId: "PO-008378", customerPODate: "2026-04-07",
    customerSO: "SO-010693", customerSOId: "SO-010693", reference: "EGT0518",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-157", companySOId: "SO-2604-157", companySODate: "2026-04-09",
    customerDeliveryDate: "2026-04-17", hookkaExpectedDD: "2026-04-15", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-164", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-10", fabricCode: "PC151-10", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 57000, lineTotalSen: 57000, notes: "" },
    ],
    subtotalSen: 57000, totalSen: 57000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-158 / PO-008379 / Houzs KL
  {
    id: "so-bf-105",
    customerPO: "PO-008379", customerPOId: "PO-008379", customerPODate: "2026-04-07",
    customerSO: "SO-011128", customerSOId: "SO-011128", reference: "HC10632",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-158", companySOId: "SO-2604-158", companySODate: "2026-04-09",
    customerDeliveryDate: "2026-04-21", hookkaExpectedDD: "2026-04-19", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-165", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "Front Drawer", specialOrderPriceSen: 12000, basePriceSen: 40000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 52000, totalSen: 52000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-159 / PO-008380 / Houzs SRW
  {
    id: "so-bf-106",
    customerPO: "PO-008380", customerPOId: "PO-008380", customerPODate: "2026-04-07",
    customerSO: "SO-011138", customerSOId: "SO-011138", reference: "HC10186",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2604-159", companySOId: "SO-2604-159", companySODate: "2026-04-09",
    customerDeliveryDate: "2026-04-29", hookkaExpectedDD: "2026-04-27", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-166", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--SS-", productCode: "1007-(SS)", productName: "1007-(SS)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "3.5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 39000, unitPriceSen: 39000, lineTotalSen: 39000, notes: "" },
    ],
    subtotalSen: 39000, totalSen: 39000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-160 / PO-008381 / Houzs KL
  {
    id: "so-bf-107",
    customerPO: "PO-008381", customerPOId: "PO-008381", customerPODate: "2026-04-07",
    customerSO: "SO-011139", customerSOId: "SO-011139", reference: "HC14180",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-160", companySOId: "SO-2604-160", companySODate: "2026-04-09",
    customerDeliveryDate: "2026-04-29", hookkaExpectedDD: "2026-04-27", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-167", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-161 / PO-008382 / Houzs KL
  {
    id: "so-bf-108",
    customerPO: "PO-008382", customerPOId: "PO-008382", customerPODate: "2026-04-07",
    customerSO: "SO-011141", customerSOId: "SO-011141", reference: "HC14261",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-161", companySOId: "SO-2604-161", companySODate: "2026-04-09",
    customerDeliveryDate: "2026-04-29", hookkaExpectedDD: "2026-04-27", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-168", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 52000, totalSen: 52000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-07T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-162 / PO-008385 / Houzs PG
  {
    id: "so-bf-109",
    customerPO: "PO-008385", customerPOId: "PO-008385", customerPODate: "2026-04-08",
    customerSO: "SO-007759", customerSOId: "SO-007759", reference: "HC8502",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-162", companySOId: "SO-2604-162", companySODate: "2026-04-09",
    customerDeliveryDate: "2026-04-28", hookkaExpectedDD: "2026-04-26", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-169", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-163 / PO-008386 / Houzs KL
  {
    id: "so-bf-110",
    customerPO: "PO-008386", customerPOId: "PO-008386", customerPODate: "2025-04-08",
    customerSO: "SO-009333", customerSOId: "SO-009333", reference: "HC10512",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-163", companySOId: "SO-2604-163", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-28", hookkaExpectedDD: "2026-04-26", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-170", lineNo: 1, lineSuffix: "-01", productId: "prod-2038-A---K-", productCode: "2038(A)-(K)", productName: "2038(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 6, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 68000, lineTotalSen: 68000, notes: "" },
    ],
    subtotalSen: 68000, totalSen: 68000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2025-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-164 / PO-008387 / Houzs KL
  {
    id: "so-bf-111",
    customerPO: "PO-008387", customerPOId: "PO-008387", customerPODate: "2026-04-08",
    customerSO: "SO-009429", customerSOId: "SO-009429", reference: "HC10509",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-164", companySOId: "SO-2604-164", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-22", hookkaExpectedDD: "2026-04-20", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-171", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
      { id: "soi-bf-172", lineNo: 2, lineSuffix: "-02", productId: "prod-1005--Q-", productCode: "1005-(Q)", productName: "1005-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 92000, totalSen: 92000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-165 / PO-008388 / Houzs KL
  {
    id: "so-bf-112",
    customerPO: "PO-008388", customerPOId: "PO-008388", customerPODate: "2026-04-08",
    customerSO: "SO-010773", customerSOId: "SO-010773", reference: "HC12412",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-165", companySOId: "SO-2604-165", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-22", hookkaExpectedDD: "2026-04-20", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-173", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---K-", productCode: "1003(A)-(K)", productName: "1003(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 68000, lineTotalSen: 68000, notes: "" },
      { id: "soi-bf-174", lineNo: 2, lineSuffix: "-02", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 124000, totalSen: 124000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-166 / PO-008389 / Houzs KL
  {
    id: "so-bf-113",
    customerPO: "PO-008389", customerPOId: "PO-008389", customerPODate: "2026-04-08",
    customerSO: "SO-011109", customerSOId: "SO-011109", reference: "EGT0188",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-166", companySOId: "SO-2604-166", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-27", hookkaExpectedDD: "2026-04-25", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-175", lineNo: 1, lineSuffix: "-01", productId: "prod-2023--S-", productCode: "2023-(S)", productName: "2023-(S)", itemCategory: "BEDFRAME", sizeCode: "", sizeLabel: "", fabricId: "fab-KS-17 ROCK GRANITE", fabricCode: "KS-17 ROCK GRANITE", quantity: 1, gapInches: null, divanHeightInches: null, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 0, unitPriceSen: 0, lineTotalSen: 0, notes: "" },
    ],
    subtotalSen: 0, totalSen: 0,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-167 / PO-008390 / Houzs KL
  {
    id: "so-bf-114",
    customerPO: "PO-008390", customerPOId: "PO-008390", customerPODate: "2026-04-08",
    customerSO: "SO-011127", customerSOId: "SO-011127", reference: "HC14063",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-167", companySOId: "SO-2604-167", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-20", hookkaExpectedDD: "2026-05-18", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-176", lineNo: 1, lineSuffix: "-01", productId: "prod-1003-A---SK-", productCode: "1003(A)-(SK)", productName: "1003(A)-(SK)", itemCategory: "BEDFRAME", sizeCode: "", sizeLabel: "200CMX200CM", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "Front Drawer", specialOrderPriceSen: 12000, basePriceSen: 112000, unitPriceSen: 129000, lineTotalSen: 129000, notes: "" },
      { id: "soi-bf-177", lineNo: 2, lineSuffix: "-02", productId: "prod-1003-A---K-", productCode: "1003(A)-(K)", productName: "1003(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-04", fabricCode: "PC151-04", quantity: 1, gapInches: 14, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "Front Drawer", specialOrderPriceSen: 12000, basePriceSen: 68000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
    ],
    subtotalSen: 214000, totalSen: 214000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-168 / PO-008391 / Houzs SRW
  {
    id: "so-bf-115",
    customerPO: "PO-008391", customerPOId: "PO-008391", customerPODate: "2026-04-08",
    customerSO: "SO-011134", customerSOId: "SO-011134", reference: "HC10194",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2604-168", companySOId: "SO-2604-168", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-20", hookkaExpectedDD: "2026-04-18", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-178", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-18", fabricCode: "PC151-18", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-169 / PO-008392 / Houzs KL
  {
    id: "so-bf-116",
    customerPO: "PO-008392", customerPOId: "PO-008392", customerPODate: "2026-04-08",
    customerSO: "SO-011152", customerSOId: "SO-011152", reference: "HC12444",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-169", companySOId: "SO-2604-169", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "2026-04-22", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-179", lineNo: 1, lineSuffix: "-01", productId: "prod-DIVAN--Q-", productCode: "DIVAN-(Q)", productName: "DIVAN-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: null, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 30000, unitPriceSen: 35000, lineTotalSen: 35000, notes: "" },
      { id: "soi-bf-180", lineNo: 2, lineSuffix: "-02", productId: "prod-DIVAN--SS-", productCode: "DIVAN-(SS)", productName: "DIVAN-(SS)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "3.5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: null, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 29000, unitPriceSen: 34000, lineTotalSen: 34000, notes: "" },
    ],
    subtotalSen: 69000, totalSen: 69000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-170 / PO-008394 / Houzs KL
  {
    id: "so-bf-117",
    customerPO: "PO-008394", customerPOId: "PO-008394", customerPODate: "2026-04-08",
    customerSO: "SO-011157", customerSOId: "SO-011157", reference: "HC9646",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-170", companySOId: "SO-2604-170", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-22", hookkaExpectedDD: "2026-04-20", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-181", lineNo: 1, lineSuffix: "-01", productId: "prod-1005--K-", productCode: "1005-(K)", productName: "1005-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
      { id: "soi-bf-182", lineNo: 2, lineSuffix: "-02", productId: "prod-1005--Q-", productCode: "1005-(Q)", productName: "1005-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 92000, totalSen: 92000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-171 / PO-008396 / Houzs KL
  {
    id: "so-bf-118",
    customerPO: "PO-008396", customerPOId: "PO-008396", customerPODate: "2026-04-08",
    customerSO: "SO-011168", customerSOId: "SO-011168", reference: "HC9397",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-171", companySOId: "SO-2604-171", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-08", hookkaExpectedDD: "2026-05-06", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-183", lineNo: 1, lineSuffix: "-01", productId: "prod-1005--K-", productCode: "1005-(K)", productName: "1005-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-18", fabricCode: "PC151-18", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 52000, totalSen: 52000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-172 / PO-2604-035 / Carress
  {
    id: "so-bf-119",
    customerPO: "PO-2604-035", customerPOId: "PO-2604-035", customerPODate: "2026-04-08",
    customerSO: "", customerSOId: "", reference: "CR0930",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-172", companySOId: "SO-2604-172", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-14", hookkaExpectedDD: "2026-04-12", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-184", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-09", fabricCode: "PC151-09", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-173 / DLAKE 21-05 / The Conts
  {
    id: "so-bf-120",
    customerPO: "DLAKE 21-05", customerPOId: "DLAKE 21-05", customerPODate: "2026-04-09",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-3", customerName: "The Conts", customerState: "KL",
    companySO: "SO-2604-173", companySOId: "SO-2604-173", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-22", hookkaExpectedDD: "2026-04-20", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-185", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-186", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-09T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-174 / STOCK 1 / The Conts
  {
    id: "so-bf-121",
    customerPO: "STOCK 1", customerPOId: "STOCK 1", customerPODate: "2026-04-09",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-3", customerName: "The Conts", customerState: "KL",
    companySO: "SO-2604-174", companySOId: "SO-2604-174", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-22", hookkaExpectedDD: "", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-187", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-188", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-189", lineNo: 3, lineSuffix: "-03", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 84000, totalSen: 84000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-09T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-175 / PO-2604-045 / Carress
  {
    id: "so-bf-122",
    customerPO: "PO-2604-045", customerPOId: "PO-2604-045", customerPODate: "2026-04-13",
    customerSO: "", customerSOId: "", reference: "",
    customerId: "cust-2", customerName: "Carress", customerState: "KL",
    companySO: "SO-2604-175", companySOId: "SO-2604-175", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-04", hookkaExpectedDD: "2026-05-02", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-190", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-191", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 56000, totalSen: 56000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-13T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-176 / PO-008403 / Houzs KL
  {
    id: "so-bf-123",
    customerPO: "PO-008403", customerPOId: "PO-008403", customerPODate: "2026-04-10",
    customerSO: "SO-002847", customerSOId: "SO-002847", reference: "HC4234",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-176", companySOId: "SO-2604-176", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "2026-04-22", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-192", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-177 / PO-008404 / Houzs KL
  {
    id: "so-bf-124",
    customerPO: "PO-008404", customerPOId: "PO-008404", customerPODate: "2026-04-10",
    customerSO: "SO-005095", customerSOId: "SO-005095", reference: "HC5600",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-177", companySOId: "SO-2604-177", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-30", hookkaExpectedDD: "2026-04-28", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-193", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
      { id: "soi-bf-194", lineNo: 2, lineSuffix: "-02", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
      { id: "soi-bf-195", lineNo: 3, lineSuffix: "-03", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "HB Straight", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
      { id: "soi-bf-196", lineNo: 4, lineSuffix: "-04", productId: "prod-1003-A---Q-", productCode: "1003(A)-(Q)", productName: "1003(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-10", fabricCode: "PC151-10", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 248000, totalSen: 248000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-178 / PO-008405 / Houzs SRW
  {
    id: "so-bf-125",
    customerPO: "PO-008405", customerPOId: "PO-008405", customerPODate: "2026-04-10",
    customerSO: "SO-007839", customerSOId: "SO-007839", reference: "HC9654",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2604-178", companySOId: "SO-2604-178", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "2026-04-22", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-197", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-KS-15 COOL SILVER", fabricCode: "KS-15 COOL SILVER", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-179 / PO-008406 / Houzs SRW
  {
    id: "so-bf-126",
    customerPO: "PO-008406", customerPOId: "PO-008406", customerPODate: "2026-04-10",
    customerSO: "SO-008979", customerSOId: "SO-008979", reference: "HC9093",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2604-179", companySOId: "SO-2604-179", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-27", hookkaExpectedDD: "2026-04-25", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-198", lineNo: 1, lineSuffix: "-01", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 85000, lineTotalSen: 85000, notes: "" },
    ],
    subtotalSen: 85000, totalSen: 85000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-180 / PO-008407 / Houzs PG
  {
    id: "so-bf-127",
    customerPO: "PO-008407", customerPOId: "PO-008407", customerPODate: "2026-04-10",
    customerSO: "SO-009794", customerSOId: "SO-009794", reference: "HC10134",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-180", companySOId: "SO-2604-180", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-28", hookkaExpectedDD: "2026-04-26", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-199", lineNo: 1, lineSuffix: "-01", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
      { id: "soi-bf-200", lineNo: 2, lineSuffix: "-02", productId: "prod-2041-A---Q-", productCode: "2041(A)-(Q)", productName: "2041(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
      { id: "soi-bf-201", lineNo: 3, lineSuffix: "-03", productId: "prod-2041-A---Q-", productCode: "2041(A)-(Q)", productName: "2041(A)-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 56000, unitPriceSen: 56000, lineTotalSen: 56000, notes: "" },
    ],
    subtotalSen: 192000, totalSen: 192000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-181 / PO-008408 / Houzs KL
  {
    id: "so-bf-128",
    customerPO: "PO-008408", customerPOId: "PO-008408", customerPODate: "2026-04-10",
    customerSO: "SO-010241", customerSOId: "SO-010241", reference: "HC10474",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-181", companySOId: "SO-2604-181", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "2026-04-22", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-202", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-15", fabricCode: "PC151-15", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-203", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--S-", productCode: "1007-(S)", productName: "1007-(S)", itemCategory: "BEDFRAME", sizeCode: "S", sizeLabel: "3FT", fabricId: "fab-PC151-16", fabricCode: "PC151-16", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 38000, unitPriceSen: 38000, lineTotalSen: 38000, notes: "" },
    ],
    subtotalSen: 78000, totalSen: 78000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-182 / PO-008409 / Houzs KL
  {
    id: "so-bf-129",
    customerPO: "PO-008409", customerPOId: "PO-008409", customerPODate: "2026-04-10",
    customerSO: "SO-010493", customerSOId: "SO-010493", reference: "HC10481",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-182", companySOId: "SO-2604-182", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-13", hookkaExpectedDD: "2026-05-11", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-204", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
      { id: "soi-bf-205", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--K-", productCode: "1013-(K)", productName: "1013-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 68000, totalSen: 68000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-183 / PO-008412 / Houzs SRW
  {
    id: "so-bf-130",
    customerPO: "PO-008412", customerPOId: "PO-008412", customerPODate: "2026-04-10",
    customerSO: "SO-011149", customerSOId: "SO-011149", reference: "HC10182+10183",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2604-183", companySOId: "SO-2604-183", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-25", hookkaExpectedDD: "2026-04-23", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-206", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-KS-15 COOL SILVER", fabricCode: "KS-15 COOL SILVER", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-184 / PO-008413 / Houzs SRW
  {
    id: "so-bf-131",
    customerPO: "PO-008413", customerPOId: "PO-008413", customerPODate: "2026-04-10",
    customerSO: "SO-011182", customerSOId: "SO-011182", reference: "HC10183+10182",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2604-184", companySOId: "SO-2604-184", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-27", hookkaExpectedDD: "2026-04-25", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-207", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-KS-15 COOL SILVER", fabricCode: "KS-15 COOL SILVER", quantity: 1, gapInches: 10, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 28000, totalSen: 28000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-185 / PO-008414 / Houzs SRW
  {
    id: "so-bf-132",
    customerPO: "PO-008414", customerPOId: "PO-008414", customerPODate: "2026-04-10",
    customerSO: "SO-011184", customerSOId: "SO-011184", reference: "HC9226",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2604-185", companySOId: "SO-2604-185", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-24", hookkaExpectedDD: "2026-04-22", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-208", lineNo: 1, lineSuffix: "-01", productId: "prod-1005--Q-", productCode: "1005-(Q)", productName: "1005-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-03", fabricCode: "PC151-03", quantity: 1, gapInches: 12, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 45000, lineTotalSen: 45000, notes: "" },
    ],
    subtotalSen: 45000, totalSen: 45000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-186 / PO-008415 / Houzs SRW
  {
    id: "so-bf-133",
    customerPO: "PO-008415", customerPOId: "PO-008415", customerPODate: "2026-04-10",
    customerSO: "SO-011195", customerSOId: "SO-011195", reference: "HC9230",
    customerId: "cust-1", customerName: "Houzs SRW", customerState: "KL",
    companySO: "SO-2604-186", companySOId: "SO-2604-186", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-27", hookkaExpectedDD: "2026-04-25", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-209", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 52000, totalSen: 52000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-10T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-187 / PO-008434 / Houzs PG
  {
    id: "so-bf-134",
    customerPO: "PO-008434", customerPOId: "PO-008434", customerPODate: "2026-04-13",
    customerSO: "SO-009730", customerSOId: "SO-009730", reference: "HC10132",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-187", companySOId: "SO-2604-187", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-23", hookkaExpectedDD: "2026-04-21", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-210", lineNo: 1, lineSuffix: "-01", productId: "prod-1005--K-", productCode: "1005-(K)", productName: "1005-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-06", fabricCode: "PC151-06", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
      { id: "soi-bf-211", lineNo: 2, lineSuffix: "-02", productId: "prod-1005--Q-", productCode: "1005-(Q)", productName: "1005-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-06", fabricCode: "PC151-06", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-212", lineNo: 3, lineSuffix: "-03", productId: "prod-1005--SS-", productCode: "1005-(SS)", productName: "1005-(SS)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "3.5FT", fabricId: "fab-PC151-08", fabricCode: "PC151-08", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 39000, unitPriceSen: 39000, lineTotalSen: 39000, notes: "" },
      { id: "soi-bf-213", lineNo: 4, lineSuffix: "-04", productId: "prod-1005--SS-", productCode: "1005-(SS)", productName: "1005-(SS)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "3.5FT", fabricId: "fab-PC151-06", fabricCode: "PC151-06", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 39000, unitPriceSen: 39000, lineTotalSen: 39000, notes: "" },
    ],
    subtotalSen: 170000, totalSen: 170000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-13T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-188 / PO-008433 / Houzs KL
  {
    id: "so-bf-135",
    customerPO: "PO-008433", customerPOId: "PO-008433", customerPODate: "2026-04-13",
    customerSO: "SO-004979", customerSOId: "SO-004979", reference: "HC5873",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-188", companySOId: "SO-2604-188", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-06", hookkaExpectedDD: "2026-05-04", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-214", lineNo: 1, lineSuffix: "-01", productId: "prod-2006-A---K-", productCode: "2006(A)-(K)", productName: "2006(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-18", fabricCode: "PC151-18", quantity: 1, gapInches: 10, divanHeightInches: 10, divanPriceSen: 5000, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 67000, unitPriceSen: 72000, lineTotalSen: 72000, notes: "" },
    ],
    subtotalSen: 72000, totalSen: 72000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-13T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-189 / PO-008443 / Houzs PG
  {
    id: "so-bf-136",
    customerPO: "PO-008443", customerPOId: "PO-008443", customerPODate: "2026-04-14",
    customerSO: "SO-000947", customerSOId: "SO-000947", reference: "AKHC2232",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-189", companySOId: "SO-2604-189", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-30", hookkaExpectedDD: "2026-04-28", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-215", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-216", lineNo: 2, lineSuffix: "-02", productId: "prod-2009-A---K-", productCode: "2009(A)-(K)", productName: "2009(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 120000, totalSen: 120000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-14T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-190 / PO-008444 / Houzs KL
  {
    id: "so-bf-137",
    customerPO: "PO-008444", customerPOId: "PO-008444", customerPODate: "2026-04-14",
    customerSO: "SO-008386", customerSOId: "SO-008386", reference: "HC8925",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-190", companySOId: "SO-2604-190", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-23", hookkaExpectedDD: "2026-04-21", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-217", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--K-", productCode: "1007-(K)", productName: "1007-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-03", fabricCode: "PC151-03", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 52000, unitPriceSen: 52000, lineTotalSen: 52000, notes: "" },
    ],
    subtotalSen: 52000, totalSen: 52000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-14T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-191 / PO-008445 / Houzs KL
  {
    id: "so-bf-138",
    customerPO: "PO-008445", customerPOId: "PO-008445", customerPODate: "2026-04-14",
    customerSO: "SO-009637", customerSOId: "SO-009637", reference: "HC12474",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-191", companySOId: "SO-2604-191", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-11", hookkaExpectedDD: "2026-05-09", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-218", lineNo: 1, lineSuffix: "-01", productId: "prod-2038-A---K-", productCode: "2038(A)-(K)", productName: "2038(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 68000, lineTotalSen: 68000, notes: "" },
      { id: "soi-bf-219", lineNo: 2, lineSuffix: "-02", productId: "prod-2038-A---K-", productCode: "2038(A)-(K)", productName: "2038(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 68000, unitPriceSen: 68000, lineTotalSen: 68000, notes: "" },
      { id: "soi-bf-220", lineNo: 3, lineSuffix: "-03", productId: "prod-2008-A---K-", productCode: "2008(A)-(K)", productName: "2008(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 80000, unitPriceSen: 80000, lineTotalSen: 80000, notes: "" },
    ],
    subtotalSen: 216000, totalSen: 216000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-14T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-192 / PO-008446 / Houzs PG
  {
    id: "so-bf-139",
    customerPO: "PO-008446", customerPOId: "PO-008446", customerPODate: "2026-04-14",
    customerSO: "SO-009777", customerSOId: "SO-009777", reference: "HC10126",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-192", companySOId: "SO-2604-192", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-05", hookkaExpectedDD: "2026-05-03", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-221", lineNo: 1, lineSuffix: "-01", productId: "prod-2006-A---K-", productCode: "2006(A)-(K)", productName: "2006(A)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 2, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 67000, unitPriceSen: 67000, lineTotalSen: 67000, notes: "" },
    ],
    subtotalSen: 67000, totalSen: 67000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-14T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-193 / PO-008447 / Houzs KL
  {
    id: "so-bf-140",
    customerPO: "PO-008447", customerPOId: "PO-008447", customerPODate: "2026-04-14",
    customerSO: "SO-010772", customerSOId: "SO-010772", reference: "HC14472",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-193", companySOId: "SO-2604-193", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-11", hookkaExpectedDD: "2026-05-09", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-222", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-223", lineNo: 2, lineSuffix: "-02", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-17", fabricCode: "PC151-17", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 80000, totalSen: 80000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-14T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-194 / PO-008448 / Houzs KL
  {
    id: "so-bf-141",
    customerPO: "PO-008448", customerPOId: "PO-008448", customerPODate: "2026-04-14",
    customerSO: "SO-011234", customerSOId: "SO-011234", reference: "HC14478",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-194", companySOId: "SO-2604-194", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-15", hookkaExpectedDD: "2026-05-13", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-224", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-13", fabricCode: "PC151-13", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-14T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-195 / PO-008449 / Houzs PG
  {
    id: "so-bf-142",
    customerPO: "PO-008449", customerPOId: "PO-008449", customerPODate: "2026-04-14",
    customerSO: "SO-011238", customerSOId: "SO-011238", reference: "HC9198",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-195", companySOId: "SO-2604-195", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-05", hookkaExpectedDD: "2026-05-03", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-225", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
    ],
    subtotalSen: 40000, totalSen: 40000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-14T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-196 / PO-008450 / Houzs PG
  {
    id: "so-bf-143",
    customerPO: "PO-008450", customerPOId: "PO-008450", customerPODate: "2026-04-14",
    customerSO: "SO-011240", customerSOId: "SO-011240", reference: "HC14351",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-196", companySOId: "SO-2604-196", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-05", hookkaExpectedDD: "2026-05-03", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-226", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--Q-", productCode: "1007-(Q)", productName: "1007-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 40000, unitPriceSen: 40000, lineTotalSen: 40000, notes: "" },
      { id: "soi-bf-227", lineNo: 2, lineSuffix: "-02", productId: "prod-1013--Q-", productCode: "1013-(Q)", productName: "1013-(Q)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "5FT", fabricId: "fab-PC151-02", fabricCode: "PC151-02", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 4, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 28000, unitPriceSen: 28000, lineTotalSen: 28000, notes: "" },
    ],
    subtotalSen: 68000, totalSen: 68000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-14T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-197 / PO-008451 / Houzs PG
  {
    id: "so-bf-144",
    customerPO: "PO-008451", customerPOId: "PO-008451", customerPODate: "2026-04-14",
    customerSO: "SO-011247", customerSOId: "SO-011247", reference: "HC9236",
    customerId: "cust-1", customerName: "Houzs PG", customerState: "PG",
    companySO: "SO-2604-197", companySOId: "SO-2604-197", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-05-11", hookkaExpectedDD: "2026-05-09", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-228", lineNo: 1, lineSuffix: "-01", productId: "prod-1013--SS-", productCode: "1013-(SS)", productName: "1013-(SS)", itemCategory: "BEDFRAME", sizeCode: "Q", sizeLabel: "3.5FT", fabricId: "fab-PC151-13", fabricCode: "PC151-13", quantity: 1, gapInches: 12, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: 0, legPriceSen: 0, specialOrder: "", specialOrderPriceSen: 0, basePriceSen: 27000, unitPriceSen: 27000, lineTotalSen: 27000, notes: "" },
    ],
    subtotalSen: 27000, totalSen: 27000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-14T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
  // SO-2604-198 / PO-008395 / Houzs KL
  {
    id: "so-bf-145",
    customerPO: "PO-008395", customerPOId: "PO-008395", customerPODate: "2026-04-08",
    customerSO: "SO-011167", customerSOId: "SO-011167", reference: "HC12449",
    customerId: "cust-1", customerName: "Houzs KL", customerState: "KL",
    companySO: "SO-2604-198", companySOId: "SO-2604-198", companySODate: "2026-04-14",
    customerDeliveryDate: "2026-04-22", hookkaExpectedDD: "2026-04-20", hookkaDeliveryOrder: "",
    items: [
      { id: "soi-bf-229", lineNo: 1, lineSuffix: "-01", productId: "prod-1007--HF---W---K-", productCode: "1007 (HF) (W)-(K)", productName: "1007 (HF) (W)-(K)", itemCategory: "BEDFRAME", sizeCode: "K", sizeLabel: "6FT", fabricId: "fab-PC151-01", fabricCode: "PC151-01", quantity: 1, gapInches: 14, divanHeightInches: 13, divanPriceSen: 5000, legHeightInches: 0, legPriceSen: 0, specialOrder: "HB Fully Cover, Front Drawer", specialOrderPriceSen: 5000, basePriceSen: 52000, unitPriceSen: 62000, lineTotalSen: 62000, notes: "DRAWER 10\\\"" },
    ],
    subtotalSen: 81000, totalSen: 81000,
    status: "DRAFT", overdue: "PENDING", notes: "",
    createdAt: "2026-04-08T08:00:00Z", updatedAt: "2026-04-15T08:00:00Z",
  },
];

// --- PRODUCTION ORDERS (one per SO item, matching department sheets) ---
// Pre-build production orders for SO-1 and SO-2 which are in production/ready

// Production orders from Google Sheet department tabs
// SO-2509-238 (PO-005385): 1003(A)-(Q) for Houzs PG - COMPLETED (StockedIn=1)
// SO-2509-244 (PO-2509-241): CR0572/Carress - 4 items in Fabric Cutting

// HMR-safe mutable mock stores. Next.js (Turbopack in particular) re-executes
// this module on hot reload — if we kept `productionOrders` as a plain
// `const = []` then every save in an unrelated file would reset it to empty
// and lose any PATCH mutations (completion dates, PIC assignments, etc).
// Stashing the array on globalThis makes HMR reuse the same instance across
// reloads, so in-memory edits survive until the dev server itself restarts.
// WIP inventory item — shared between inventory and production-orders routes
export type WipItem = {
  id: string;
  code: string;
  type: string;       // HB | DIVAN | BASE | CUSHION | ARM | etc.
  relatedProduct: string;
  deptStatus: string; // last department that produced / holds this WIP
  stockQty: number;
  status: string;     // PENDING | IN_PRODUCTION | COMPLETED
};

// --- FG Unit Tracking (per physical unit × per piece of set) ---
// One FGUnit row = one physical box with its own sticker/QR. A PO with qty=3
// for a bedframe (pieces.count = 3) produces 9 FGUnit rows (3 units × 3 pieces).
// Status lifecycle:
//   A-version (legacy):  PENDING → PACKED → LOADED → DELIVERED [→ RETURNED]
//   B-version (sticker): PENDING_UPHOLSTERY → UPHOLSTERED → PACKED → LOADED → DELIVERED [→ RETURNED]
// Both are kept in the same union so existing code compiles; B-flow uses the new values.
export type FGUnitStatus =
  | "PENDING"              // legacy A
  | "PENDING_UPHOLSTERY"   // B: materialised at FG-sticker print, waiting for upholstery scan
  | "UPHOLSTERED"          // B: upholstery scan complete
  | "PACKED"
  | "LOADED"
  | "DELIVERED"
  | "RETURNED";

// Append-only trail of every scan on this FG. Inherited from source batch piece
// at materialize time, then extended by upholstery/packing/loading scans.
export interface FGScanEvent {
  timestamp: string;
  deptCode: string;           // FAB_CUT | FAB_SEW | FOAM | ... | UPHOLSTERY | PACKING | LOADING | DELIVERY
  workerId?: string;
  workerName?: string;
  picSlot?: 1 | 2;            // which PIC slot on that scan
  action: 'COMPLETE' | 'UNDO' | 'SIGN' | 'DISPATCH';
  // When inherited from a batch piece, keep a pointer back.
  sourceBatchId?: string;
  sourcePieceIndex?: number;
  sourceSlotIndex?: number;
  note?: string;
}

export interface FGUnit {
  id: string;
  unitSerial: string;       // e.g. "SO-2604-100-R1-U02-P2/3" — full canonical serial
  shortCode: string;        // e.g. "711993-2" — human-friendly 6-digit + piece suffix
  soId: string;
  soNo: string;
  soLineNo: number;
  poId: string;
  poNo: string;
  productCode: string;
  productName: string;
  unitNo: number;           // which unit of the set (1..totalUnits)
  totalUnits: number;
  pieceNo: number;          // which piece of the unit (1..totalPieces)
  totalPieces: number;
  pieceName: string;        // e.g. "HB", "Divan", "Legs"
  customerName: string;
  customerHub?: string;
  mfdDate: string | null;
  status: FGUnitStatus;
  packerId?: string;
  packerName?: string;
  packedAt?: string;
  loadedAt?: string;
  deliveredAt?: string;
  returnedAt?: string;

  // ---------- B-flow extensions ----------
  // Link back to the source batch (FAB_CUT/FAB_SEW history lives there).
  batchId?: string;
  // Which piece index + slot index inside that batch materialised this FG.
  sourcePieceIndex?: number;
  sourceSlotIndex?: number;
  // Upholstery PIC fields (set when upholstery scan completes).
  upholsteredBy?: string;
  upholsteredByName?: string;
  upholsteredAt?: string;
  // Delivery order link (set when added to a DO; cleared on removal).
  doId?: string;
  // Append-only scan history for rework/return traceability.
  scanHistory?: FGScanEvent[];
}

const __g = globalThis as unknown as {
  __hookka_productionOrders__?: ProductionOrder[];
  __hookka_deliveryOrders__?: DeliveryOrder[];
  __hookka_wipItems__?: WipItem[];
  __hookka_fgUnits__?: FGUnit[];
};
if (!__g.__hookka_productionOrders__) {
  __g.__hookka_productionOrders__ = [];
}
if (!__g.__hookka_deliveryOrders__) __g.__hookka_deliveryOrders__ = [];
if (!__g.__hookka_fgUnits__) __g.__hookka_fgUnits__ = [];
if (!__g.__hookka_wipItems__) {
  __g.__hookka_wipItems__ = [
    { id: 'wip-1',  code: '1003(A)(Q)-HB22"',  type: 'HB',     relatedProduct: '1003(A)-(Q)', deptStatus: 'UPHOLSTERY', stockQty: 3, status: 'COMPLETED'    },
    { id: 'wip-2',  code: '1003(A)(K)-HB22"',  type: 'HB',     relatedProduct: '1003(A)-(K)', deptStatus: 'FRAMING',    stockQty: 0, status: 'IN_PRODUCTION' },
    { id: 'wip-3',  code: '1009(A)(Q)-HB24"',  type: 'HB',     relatedProduct: '1009(A)-(Q)', deptStatus: 'UPHOLSTERY', stockQty: 5, status: 'COMPLETED'    },
    { id: 'wip-4',  code: '1009(A)(K)-HB24"',  type: 'HB',     relatedProduct: '1009(A)-(K)', deptStatus: 'FOAM',       stockQty: 0, status: 'IN_PRODUCTION' },
    { id: 'wip-5',  code: '1013(Q)-HB20"',     type: 'HB',     relatedProduct: '1013-(Q)',    deptStatus: 'PACKING',    stockQty: 8, status: 'COMPLETED'    },
    { id: 'wip-6',  code: '8" Divan-5FT',      type: 'DIVAN',  relatedProduct: 'DIVAN-(Q)',   deptStatus: 'FRAMING',    stockQty: 2, status: 'IN_PRODUCTION' },
    { id: 'wip-7',  code: '8" Divan-6FT',      type: 'DIVAN',  relatedProduct: 'DIVAN-(K)',   deptStatus: 'UPHOLSTERY', stockQty: 6, status: 'COMPLETED'    },
    { id: 'wip-8',  code: '10" Divan-5FT',     type: 'DIVAN',  relatedProduct: 'DIVAN-(Q)',   deptStatus: 'WOOD_CUT',   stockQty: 0, status: 'PENDING'      },
    { id: 'wip-9',  code: '10" Divan-6FT',     type: 'DIVAN',  relatedProduct: 'DIVAN-(K)',   deptStatus: 'FRAMING',    stockQty: 1, status: 'IN_PRODUCTION' },
    { id: 'wip-10', code: '12" Divan-3FT',     type: 'DIVAN',  relatedProduct: 'DIVAN-(S)',   deptStatus: 'PACKING',    stockQty: 4, status: 'COMPLETED'    },
    { id: 'wip-11', code: '5530-1NA-28"-BASE', type: 'BASE',   relatedProduct: '5530-1NA',    deptStatus: 'FRAMING',    stockQty: 0, status: 'IN_PRODUCTION' },
    { id: 'wip-12', code: '5535-2A-28"-BASE',  type: 'BASE',   relatedProduct: '5535-2A',     deptStatus: 'UPHOLSTERY', stockQty: 3, status: 'COMPLETED'    },
    { id: 'wip-13', code: '5535-1NA-26"-BASE', type: 'BASE',   relatedProduct: '5535-1NA',    deptStatus: 'WEBBING',    stockQty: 0, status: 'IN_PRODUCTION' },
    { id: 'wip-14', code: '5560-2A-30"-BASE',  type: 'BASE',   relatedProduct: '5560-2A',     deptStatus: 'FOAM',       stockQty: 0, status: 'PENDING'      },
    { id: 'wip-15', code: '5530-28"-CUSHION',  type: 'CUSHION',relatedProduct: '5530-1NA',    deptStatus: 'FAB_SEW',    stockQty: 2, status: 'IN_PRODUCTION' },
    { id: 'wip-16', code: '5535-28"-CUSHION',  type: 'CUSHION',relatedProduct: '5535-2A',     deptStatus: 'UPHOLSTERY', stockQty: 7, status: 'COMPLETED'    },
    { id: 'wip-17', code: '5535-26"-CUSHION',  type: 'CUSHION',relatedProduct: '5535-1NA',    deptStatus: 'FAB_CUT',    stockQty: 0, status: 'PENDING'      },
    { id: 'wip-18', code: '5560-30"-CUSHION',  type: 'CUSHION',relatedProduct: '5560-2A',     deptStatus: 'FOAM',       stockQty: 0, status: 'PENDING'      },
    { id: 'wip-19', code: '1020(Q)-HB18"',     type: 'HB',     relatedProduct: '1020-(Q)',    deptStatus: 'FAB_SEW',    stockQty: 0, status: 'IN_PRODUCTION' },
    { id: 'wip-20', code: '8" Divan-3.5FT',    type: 'DIVAN',  relatedProduct: 'DIVAN-(SS)',  deptStatus: 'PACKING',    stockQty: 3, status: 'COMPLETED'    },
  ];
}
export const productionOrders: ProductionOrder[] = __g.__hookka_productionOrders__;
export const deliveryOrders: DeliveryOrder[] = __g.__hookka_deliveryOrders__;
export const wipItems: WipItem[] = __g.__hookka_wipItems__;
export const fgUnits: FGUnit[] = __g.__hookka_fgUnits__!;

// Generate FGUnit rows for a PO. Idempotent — returns existing rows if already
// generated for this poId (check by caller; this helper itself always creates).
// One unit per (unit index × piece index). Bedframe qty=3 with pieces.count=3 → 9 rows.
export function generateFGUnitsForPO(
  po: ProductionOrder,
  so: SalesOrder,
  product: Product | undefined,
): FGUnit[] {
  const pieces = product?.pieces && product.pieces.count > 0
    ? product.pieces
    : { count: 1, names: ["Full Product"] };
  const totalUnits = Math.max(1, po.quantity || 1);
  const totalPieces = pieces.count;

  // Find customer hub (first hub of the customer as best-effort; PO/SO don't
  // currently carry hubId, so we leave it optional). Can be enriched later.
  const customer = customers.find((c) => c.id === so?.customerId || c.name === po.customerName);
  const hubShort = customer?.deliveryHubs?.[0]?.shortName;

  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const unitWidth = Math.max(2, String(totalUnits).length);

  const out: FGUnit[] = [];
  // One random 6-digit "batch code" shared across all units of this PO — the
  // sticker suffix (-1/-2/-3) differentiates pieces. Matches the photo format.
  const baseBatch = String(100000 + Math.floor(Math.random() * 900000));

  for (let u = 1; u <= totalUnits; u++) {
    for (let p = 1; p <= totalPieces; p++) {
      const pieceName = pieces.names[p - 1] ?? `Piece ${p}`;
      const unitSerial = `${po.salesOrderNo}-R${po.lineNo}-U${pad(u, unitWidth)}-P${p}/${totalPieces}`;
      // Use the same base batch for all pieces of the same unit, differ by piece.
      // Different units get a different last-digit offset to stay unique.
      const unitBatch = String(Number(baseBatch) + (u - 1)).slice(-6).padStart(6, "0");
      const shortCode = `${unitBatch}-${p}`;
      out.push({
        id: `fgu-${po.id}-${u}-${p}-${generateId()}`,
        unitSerial,
        shortCode,
        soId: so?.id || po.salesOrderId,
        soNo: po.salesOrderNo,
        soLineNo: po.lineNo,
        poId: po.id,
        poNo: po.poNo,
        productCode: po.productCode,
        productName: po.productName,
        unitNo: u,
        totalUnits,
        pieceNo: p,
        totalPieces,
        pieceName,
        customerName: po.customerName,
        customerHub: hubShort,
        mfdDate: po.completedDate || po.startDate || null,
        status: "PENDING",
      });
    }
  }
  return out;
}

// ============================================================
// SUPPLIERS & PROCUREMENT
// ============================================================

export type SupplierMaterial = {
  materialCategory: string; // BM_FABRIC, PLYWOOD, etc.
  supplierSKU: string;
  unitPriceSen: number;
  leadTimeDays: number;
  minOrderQty: number;
  priority: "A" | "B" | "C"; // preferred supplier ranking
};

export type Supplier = {
  id: string;
  code: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  state: string;
  paymentTerms: string;
  status: string; // ACTIVE, INACTIVE
  rating: number; // 1-5 supplier rating
  materials: SupplierMaterial[];
};

export type POItem = {
  id: string;
  materialCategory: string;
  materialName: string;
  supplierSKU: string;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
  receivedQty: number;
  unit: string;
};

export type PurchaseOrder = {
  id: string;
  poNo: string; // PO-YYMM-XXX
  supplierId: string;
  supplierName: string;
  items: POItem[];
  subtotalSen: number;
  totalSen: number;
  status: string; // DRAFT, SUBMITTED, CONFIRMED, PARTIAL_RECEIVED, RECEIVED, CANCELLED
  orderDate: string;
  expectedDate: string;
  receivedDate: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

let _poSeq = 19;
export function getNextPONo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `PO-${yymm}-${String(_poSeq++).padStart(3, "0")}`;
}

export const suppliers: Supplier[] = [
  {
    id: "sup-1", code: "SUP-001", name: "Kain Utama Sdn Bhd",
    contactPerson: "Encik Razak", phone: "+60 12-345 1001", email: "razak@kainutama.com.my",
    address: "Lot 8, Jalan Perindustrian Batu Caves, 68100 Batu Caves, Selangor",
    state: "SGR", paymentTerms: "NET30", status: "ACTIVE", rating: 5,
    materials: [
      { materialCategory: "BM_FABRIC", supplierSKU: "KU-PC151", unitPriceSen: 2500, leadTimeDays: 7, minOrderQty: 100, priority: "A" },
      { materialCategory: "BM_FABRIC", supplierSKU: "KU-PC200", unitPriceSen: 2600, leadTimeDays: 7, minOrderQty: 100, priority: "A" },
      { materialCategory: "SM_FABRIC", supplierSKU: "KU-KN390", unitPriceSen: 3200, leadTimeDays: 10, minOrderQty: 50, priority: "B" },
      { materialCategory: "SM_FABRIC", supplierSKU: "KU-VL100", unitPriceSen: 3000, leadTimeDays: 10, minOrderQty: 50, priority: "A" },
    ],
  },
  {
    id: "sup-2", code: "SUP-002", name: "Papan Jaya Trading",
    contactPerson: "Mr. Lim Hock", phone: "+60 12-345 1002", email: "lim@papanjaya.com.my",
    address: "No 15, Jalan Kayu, Taman Perindustrian, 81700 Pasir Gudang, Johor",
    state: "JHR", paymentTerms: "NET30", status: "ACTIVE", rating: 4,
    materials: [
      { materialCategory: "PLYWOOD", supplierSKU: "PJ-PLY-12", unitPriceSen: 4500, leadTimeDays: 5, minOrderQty: 50, priority: "A" },
      { materialCategory: "PLYWOOD", supplierSKU: "PJ-PLY-18", unitPriceSen: 6200, leadTimeDays: 5, minOrderQty: 30, priority: "A" },
      { materialCategory: "WD_STRIP", supplierSKU: "PJ-WDS-25", unitPriceSen: 1800, leadTimeDays: 5, minOrderQty: 100, priority: "A" },
    ],
  },
  {
    id: "sup-3", code: "SUP-003", name: "Foam Industries M'sia Sdn Bhd",
    contactPerson: "Puan Noraini", phone: "+60 12-345 1003", email: "noraini@foamind.com.my",
    address: "Lot 22, Jalan Industri 3, Kawasan Perindustrian Rawang, 48000 Rawang, Selangor",
    state: "SGR", paymentTerms: "NET14", status: "ACTIVE", rating: 4,
    materials: [
      { materialCategory: "B_FILLER", supplierSKU: "FI-HDF-25", unitPriceSen: 3500, leadTimeDays: 3, minOrderQty: 20, priority: "A" },
      { materialCategory: "B_FILLER", supplierSKU: "FI-HDF-50", unitPriceSen: 5800, leadTimeDays: 3, minOrderQty: 10, priority: "A" },
      { materialCategory: "B_FILLER", supplierSKU: "FI-SFT-25", unitPriceSen: 2800, leadTimeDays: 3, minOrderQty: 20, priority: "B" },
    ],
  },
  {
    id: "sup-4", code: "SUP-004", name: "Hardware Plus Sdn Bhd",
    contactPerson: "Mr. Tan Kah Wai", phone: "+60 12-345 1004", email: "tan@hardwareplus.com.my",
    address: "No 5, Jalan SS 13/4, Subang Jaya, 47500 Selangor",
    state: "SGR", paymentTerms: "NET30", status: "ACTIVE", rating: 3,
    materials: [
      { materialCategory: "ACCESSORIES", supplierSKU: "HP-LEG-06", unitPriceSen: 1200, leadTimeDays: 7, minOrderQty: 50, priority: "A" },
      { materialCategory: "ACCESSORIES", supplierSKU: "HP-LEG-08", unitPriceSen: 1500, leadTimeDays: 7, minOrderQty: 50, priority: "A" },
      { materialCategory: "WEBBING", supplierSKU: "HP-WEB-50", unitPriceSen: 800, leadTimeDays: 5, minOrderQty: 100, priority: "B" },
      { materialCategory: "ACCESSORIES", supplierSKU: "HP-BOLT-SET", unitPriceSen: 350, leadTimeDays: 3, minOrderQty: 200, priority: "A" },
    ],
  },
  {
    id: "sup-5", code: "SUP-005", name: "Pack & Ship M'sia Sdn Bhd",
    contactPerson: "Encik Faizal", phone: "+60 12-345 1005", email: "faizal@packship.com.my",
    address: "Lot 30, Jalan Pelabuhan Utara, 42000 Port Klang, Selangor",
    state: "SGR", paymentTerms: "NET14", status: "ACTIVE", rating: 5,
    materials: [
      { materialCategory: "PACKING", supplierSKU: "PS-CB-K", unitPriceSen: 1500, leadTimeDays: 3, minOrderQty: 50, priority: "A" },
      { materialCategory: "PACKING", supplierSKU: "PS-CB-Q", unitPriceSen: 1200, leadTimeDays: 3, minOrderQty: 50, priority: "A" },
      { materialCategory: "PACKING", supplierSKU: "PS-WRAP-100", unitPriceSen: 2500, leadTimeDays: 3, minOrderQty: 20, priority: "A" },
    ],
  },
];

export const purchaseOrders: PurchaseOrder[] = [
  {
    id: "po-1", poNo: "PO-2604-016", supplierId: "sup-1", supplierName: "Kain Utama Sdn Bhd",
    items: [
      { id: "poi-1", materialCategory: "BM_FABRIC", materialName: "PC151 Dark Grey", supplierSKU: "KU-PC151", quantity: 200, unitPriceSen: 2500, totalSen: 500000, receivedQty: 200, unit: "meters" },
      { id: "poi-2", materialCategory: "SM_FABRIC", materialName: "VL100 Taupe", supplierSKU: "KU-VL100", quantity: 100, unitPriceSen: 3000, totalSen: 300000, receivedQty: 100, unit: "meters" },
    ],
    subtotalSen: 800000, totalSen: 800000,
    status: "RECEIVED", orderDate: "2026-04-03", expectedDate: "2026-04-10", receivedDate: "2026-04-09",
    notes: "Monthly fabric restock", createdAt: "2026-04-03T08:00:00Z", updatedAt: "2026-04-09T14:00:00Z",
  },
  {
    id: "po-2", poNo: "PO-2604-017", supplierId: "sup-2", supplierName: "Papan Jaya Trading",
    items: [
      { id: "poi-3", materialCategory: "PLYWOOD", materialName: "Plywood 12mm", supplierSKU: "PJ-PLY-12", quantity: 80, unitPriceSen: 4500, totalSen: 360000, receivedQty: 0, unit: "sheets" },
      { id: "poi-4", materialCategory: "WD_STRIP", materialName: "Wood Strip 25mm", supplierSKU: "PJ-WDS-25", quantity: 150, unitPriceSen: 1800, totalSen: 270000, receivedQty: 0, unit: "pcs" },
    ],
    subtotalSen: 630000, totalSen: 630000,
    status: "CONFIRMED", orderDate: "2026-04-08", expectedDate: "2026-04-13", receivedDate: null,
    notes: "Urgent wood restock for April orders", createdAt: "2026-04-08T09:00:00Z", updatedAt: "2026-04-08T09:00:00Z",
  },
  {
    id: "po-3", poNo: "PO-2604-018", supplierId: "sup-3", supplierName: "Foam Industries M'sia Sdn Bhd",
    items: [
      { id: "poi-5", materialCategory: "B_FILLER", materialName: "HD Foam 25mm", supplierSKU: "FI-HDF-25", quantity: 40, unitPriceSen: 3500, totalSen: 140000, receivedQty: 20, unit: "sheets" },
      { id: "poi-6", materialCategory: "B_FILLER", materialName: "HD Foam 50mm", supplierSKU: "FI-HDF-50", quantity: 20, unitPriceSen: 5800, totalSen: 116000, receivedQty: 20, unit: "sheets" },
    ],
    subtotalSen: 256000, totalSen: 256000,
    status: "PARTIAL_RECEIVED", orderDate: "2026-04-06", expectedDate: "2026-04-09", receivedDate: null,
    notes: "Partial delivery - remaining 20 sheets HDF-25 expected next week", createdAt: "2026-04-06T10:00:00Z", updatedAt: "2026-04-09T11:00:00Z",
  },
  {
    id: "po-4", poNo: "PO-2601-005", supplierId: "sup-1", supplierName: "Kain Utama Sdn Bhd",
    items: [
      { id: "poi-7", materialCategory: "BM_FABRIC", materialName: "AVANI 13 Fabric", supplierSKU: "KU-PC151", quantity: 300, unitPriceSen: 2500, totalSen: 750000, receivedQty: 300, unit: "meters" },
      { id: "poi-8", materialCategory: "BM_FABRIC", materialName: "AVANI 02 Fabric", supplierSKU: "KU-PC200", quantity: 150, unitPriceSen: 2600, totalSen: 390000, receivedQty: 150, unit: "meters" },
    ],
    subtotalSen: 1140000, totalSen: 1140000,
    status: "RECEIVED", orderDate: "2026-01-15", expectedDate: "2026-01-25", receivedDate: "2026-01-23",
    notes: "Q1 fabric replenishment", createdAt: "2026-01-15T08:00:00Z", updatedAt: "2026-01-23T14:00:00Z",
  },
  {
    id: "po-5", poNo: "PO-2602-009", supplierId: "sup-2", supplierName: "Papan Jaya Trading",
    items: [
      { id: "poi-9", materialCategory: "PLYWOOD", materialName: "18MM 4' X 8' MR AA PLYWOOD", supplierSKU: "PJ-PLY-18", quantity: 120, unitPriceSen: 6200, totalSen: 744000, receivedQty: 120, unit: "sheets" },
      { id: "poi-10", materialCategory: "PLYWOOD", materialName: "9MM 4' X 8' MR AA PLYWOOD", supplierSKU: "PJ-PLY-12", quantity: 200, unitPriceSen: 4500, totalSen: 900000, receivedQty: 200, unit: "sheets" },
    ],
    subtotalSen: 1644000, totalSen: 1644000,
    status: "RECEIVED", orderDate: "2026-02-05", expectedDate: "2026-02-12", receivedDate: "2026-02-11",
    notes: "February plywood order - full receipt", createdAt: "2026-02-05T09:00:00Z", updatedAt: "2026-02-11T15:00:00Z",
  },
  {
    id: "po-6", poNo: "PO-2603-011", supplierId: "sup-4", supplierName: "Hardware Plus Sdn Bhd",
    items: [
      { id: "poi-11", materialCategory: "ACCESSORIES", materialName: 'Bed Leg 6" Chrome', supplierSKU: "HP-LEG-06", quantity: 400, unitPriceSen: 1200, totalSen: 480000, receivedQty: 0, unit: "pcs" },
      { id: "poi-12", materialCategory: "ACCESSORIES", materialName: "Hex Bolt Set M8", supplierSKU: "HP-BOLT-SET", quantity: 600, unitPriceSen: 350, totalSen: 210000, receivedQty: 0, unit: "sets" },
    ],
    subtotalSen: 690000, totalSen: 690000,
    status: "SUBMITTED", orderDate: "2026-03-12", expectedDate: "2026-03-20", receivedDate: null,
    notes: "Hardware restock for April production", createdAt: "2026-03-12T08:00:00Z", updatedAt: "2026-03-12T08:00:00Z",
  },
  {
    id: "po-7", poNo: "PO-2603-024", supplierId: "sup-5", supplierName: "Pack & Ship M'sia Sdn Bhd",
    items: [
      { id: "poi-13", materialCategory: "PACKING", materialName: "King Size Packing Carton", supplierSKU: "PS-CB-K", quantity: 200, unitPriceSen: 1500, totalSen: 300000, receivedQty: 120, unit: "pcs" },
      { id: "poi-14", materialCategory: "PACKING", materialName: "Queen Size Packing Carton", supplierSKU: "PS-CB-Q", quantity: 250, unitPriceSen: 1200, totalSen: 300000, receivedQty: 250, unit: "pcs" },
    ],
    subtotalSen: 600000, totalSen: 600000,
    status: "PARTIAL_RECEIVED", orderDate: "2026-03-22", expectedDate: "2026-03-28", receivedDate: null,
    notes: "Short delivery on king cartons - balance due", createdAt: "2026-03-22T10:00:00Z", updatedAt: "2026-03-30T11:00:00Z",
  },
  {
    id: "po-8", poNo: "PO-2604-002", supplierId: "sup-3", supplierName: "Foam Industries M'sia Sdn Bhd",
    items: [
      { id: "poi-15", materialCategory: "B_FILLER", materialName: "Soft Foam 25mm", supplierSKU: "FI-SFT-25", quantity: 60, unitPriceSen: 2800, totalSen: 168000, receivedQty: 0, unit: "sheets" },
    ],
    subtotalSen: 62000, totalSen: 62000,
    status: "DRAFT", orderDate: "2026-04-10", expectedDate: "2026-04-15", receivedDate: null,
    notes: "Pending supplier confirmation", createdAt: "2026-04-10T11:00:00Z", updatedAt: "2026-04-10T11:00:00Z",
  },
];

// ============================================================
// WAREHOUSE - Rack Locations & Stock Movements
// ============================================================

export type RackItem = {
  productionOrderId?: string;
  productCode: string;
  productName?: string;
  sizeLabel?: string;
  customerName?: string;
  qty?: number;
  stockedInDate?: string;
  notes?: string;
};

export type RackLocation = {
  id: string;
  rack: string;        // "Rack 1" .. "Rack 20" (flat — no sub-positions)
  position: string;    // kept for backwards compat, always "" now
  status: "OCCUPIED" | "EMPTY" | "RESERVED";
  items?: RackItem[];
  reserved?: boolean;
  productionOrderId?: string;
  productCode?: string;
  productName?: string;
  sizeLabel?: string;
  customerName?: string;
  stockedInDate?: string;
  notes?: string;
};

export type StockMovement = {
  id: string;
  type: "STOCK_IN" | "STOCK_OUT" | "TRANSFER";
  rackLocationId: string;
  rackLabel: string;
  productionOrderId?: string;
  productCode: string;
  productName: string;
  quantity: number;
  reason: string;
  performedBy: string;
  createdAt: string;
};

// Flat rack layout per user request — "Rack 1" … "Rack 20", no sub-positions.
const rackNames = Array.from({ length: 20 }, (_, i) => `Rack ${i + 1}`);

// Occupied slots — simplified from the old 100-slot grid. Indexed by the
// flat rack label directly.
const occupiedSlotData: Array<{
  rack: string;
  productionOrderId?: string; productCode: string; productName: string;
  sizeLabel: string; customerName: string; stockedInDate: string; notes?: string;
}> = [
  { rack: "Rack 1", productionOrderId: productionOrders[0]?.id, productCode: "1003(A)", productName: "HILTON(A) BEDFRAME", sizeLabel: "Queen 5FT", customerName: "Houzs PG", stockedInDate: "2026-03-12" },
  { rack: "Rack 2", productCode: "1013", productName: "JAGER BEDFRAME", sizeLabel: "Queen 5FT", customerName: "Carress", stockedInDate: "2026-03-15" },
  { rack: "Rack 3", productCode: "2038(A)", productName: "Milano Bedframe", sizeLabel: "King 72x78", customerName: "The Conts", stockedInDate: "2026-04-08" },
  { rack: "Rack 4", productCode: "1009(A)", productName: "Astoria Bedframe", sizeLabel: "Super Single 42x78", customerName: "Houzs Century", stockedInDate: "2026-04-09" },
  { rack: "Rack 5", productCode: "SF-2001", productName: "Nordic 3-Seater Sofa", sizeLabel: "Standard", customerName: "Houzs Century", stockedInDate: "2026-04-07" },
  { rack: "Rack 6", productCode: "SF-2002", productName: "Luxe L-Shape Sofa", sizeLabel: "Left Configuration", customerName: "Houzs Century", stockedInDate: "2026-04-11" },
  { rack: "Rack 7", productCode: "1003(A)", productName: "Vienna Bedframe", sizeLabel: "King 72x78", customerName: "Houzs Century", stockedInDate: "2026-04-06" },
  { rack: "Rack 8", productCode: "DV-3001", productName: "Classic Divan Base", sizeLabel: "King 72x78", customerName: "Houzs Century", stockedInDate: "2026-04-12" },
];

// Reserved slots
const reservedSlotSet = new Set(["Rack 19", "Rack 20"]);

export const rackLocations: RackLocation[] = rackNames.map((rack) => {
  const occ = occupiedSlotData.find((o) => o.rack === rack);
  const reserved = reservedSlotSet.has(rack);
  return {
    id: rack,
    rack,
    position: "",
    status: occ ? "OCCUPIED" as const : reserved ? "RESERVED" as const : "EMPTY" as const,
    ...(occ ? {
      productionOrderId: occ.productionOrderId || "",
      productCode: occ.productCode,
      productName: occ.productName,
      sizeLabel: occ.sizeLabel,
      customerName: occ.customerName,
      stockedInDate: occ.stockedInDate,
      notes: occ.notes || "",
    } : {}),
  };
});

// Derive rack status from items count and reserved flag
export function computeRackStatus(
  items: unknown[] | undefined,
  reserved: boolean | undefined
): "OCCUPIED" | "EMPTY" | "RESERVED" {
  if (items && items.length > 0) return "OCCUPIED";
  if (reserved) return "RESERVED";
  return "EMPTY";
}

let _movementCounter = 10;
export function getNextMovementNo(): string {
  _movementCounter++;
  return `SM-${String(_movementCounter).padStart(4, "0")}`;
}

export const stockMovements: StockMovement[] = [
  { id: "sm-1", type: "STOCK_IN", rackLocationId: "A-01", rackLabel: "A-01", productionOrderId: productionOrders[0]?.id, productCode: "1003(A)", productName: "HILTON(A) BEDFRAME Queen", quantity: 1, reason: "Production completed - packed", performedBy: "AUNG THEIN WIN", createdAt: "2026-03-12T09:30:00Z" },
  { id: "sm-2", type: "STOCK_IN", rackLocationId: "A-02", rackLabel: "A-02", productCode: "1013", productName: "JAGER BEDFRAME Queen", quantity: 1, reason: "Production completed - packed", performedBy: "MYINT AUNG", createdAt: "2026-03-15T10:00:00Z" },
  { id: "sm-3", type: "STOCK_IN", rackLocationId: "B-01", rackLabel: "B-01", productCode: "2038(A)", productName: "Milano Bedframe King", quantity: 2, reason: "Production completed", performedBy: "AUNG THEIN WIN", createdAt: "2026-04-08T14:00:00Z" },
  { id: "sm-4", type: "STOCK_IN", rackLocationId: "C-01", rackLabel: "C-01", productCode: "SF-2001", productName: "Nordic 3-Seater Sofa", quantity: 1, reason: "Production completed", performedBy: "MYINT AUNG", createdAt: "2026-04-07T11:00:00Z" },
  { id: "sm-5", type: "STOCK_OUT", rackLocationId: "E-05", rackLabel: "E-05", productCode: "1009(A)", productName: "Astoria Bedframe King", quantity: 1, reason: "Delivered to customer - DO-2604-015", performedBy: "AUNG THEIN WIN", createdAt: "2026-04-09T08:00:00Z" },
  { id: "sm-6", type: "STOCK_OUT", rackLocationId: "E-06", rackLabel: "E-06", productCode: "1003(A)", productName: "Vienna Bedframe Queen", quantity: 1, reason: "Delivered to customer - DO-2604-015", performedBy: "AUNG THEIN WIN", createdAt: "2026-04-09T08:15:00Z" },
  { id: "sm-7", type: "STOCK_IN", rackLocationId: "D-01", rackLabel: "D-01", productCode: "1003(A)", productName: "Vienna Bedframe King", quantity: 1, reason: "Production completed", performedBy: "MYINT AUNG", createdAt: "2026-04-06T16:00:00Z" },
  { id: "sm-8", type: "TRANSFER", rackLocationId: "C-05", rackLabel: "C-05", productCode: "SF-2002", productName: "Luxe L-Shape Sofa", quantity: 1, reason: "Relocated from B-15 to C-05", performedBy: "AUNG THEIN WIN", createdAt: "2026-04-11T13:00:00Z" },
  { id: "sm-9", type: "STOCK_IN", rackLocationId: "E-01", rackLabel: "E-01", productCode: "1009(A)", productName: "Astoria Bedframe Queen", quantity: 1, reason: "Production completed", performedBy: "MYINT AUNG", createdAt: "2026-04-11T15:00:00Z" },
  { id: "sm-10", type: "STOCK_IN", rackLocationId: "D-10", rackLabel: "D-10", productCode: "DV-3001", productName: "Classic Divan Base King", quantity: 1, reason: "Production completed", performedBy: "AUNG THEIN WIN", createdAt: "2026-04-12T10:00:00Z" },
];

// --- QC INSPECTIONS ---
export type QCDefect = {
  id: string;
  type: "FABRIC" | "ALIGNMENT" | "STRUCTURAL" | "STAIN" | "DIMENSION" | "FINISH" | "OTHER";
  severity: "MINOR" | "MAJOR" | "CRITICAL";
  description: string;
  actionTaken: "REWORK" | "ACCEPT" | "REJECT" | "REPAIR";
};

export type QCInspection = {
  id: string;
  inspectionNo: string;  // QC-YYMM-XXX
  productionOrderId: string;
  poNo: string;
  productCode: string;
  productName: string;
  customerName: string;
  department: string;  // UPHOLSTERY or PACKING
  inspectorId: string;
  inspectorName: string;
  result: "PASS" | "FAIL" | "CONDITIONAL_PASS";
  defects: QCDefect[];
  notes: string;
  inspectionDate: string;
  createdAt: string;
};

let _qcSeq = 11;
export function getNextQCNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `QC-${yymm}-${String(_qcSeq++).padStart(3, "0")}`;
}

export const qcInspections: QCInspection[] = [];

// ============================================================
// ACCOUNTING - Chart of Accounts, Journal Entries, Aging
// ============================================================

export type ChartOfAccount = {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  parentCode?: string;
  balance: number; // in sen
  isActive: boolean;
};

export type JournalLine = {
  accountCode: string;
  accountName: string;
  debitSen: number;
  creditSen: number;
  description: string;
};

export type JournalEntry = {
  id: string;
  entryNo: string;
  date: string;
  description: string;
  lines: JournalLine[];
  status: "DRAFT" | "POSTED" | "REVERSED";
  createdBy: string;
  createdAt: string;
};

export type ARAgingEntry = {
  customerId: string;
  customerName: string;
  currentSen: number;
  days30Sen: number;
  days60Sen: number;
  days90Sen: number;
  over90Sen: number;
};

export type APAgingEntry = {
  supplierId: string;
  supplierName: string;
  currentSen: number;
  days30Sen: number;
  days60Sen: number;
  days90Sen: number;
  over90Sen: number;
};

export const chartOfAccounts: ChartOfAccount[] = [];

let _jeSeq = 43;
export function getNextJENo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `JE-${yymm}-${String(_jeSeq++).padStart(4, "0")}`;
}

export const journalEntries: JournalEntry[] = [];

export const arAging: ARAgingEntry[] = [];

export const apAging: APAgingEntry[] = [];

// ============================================================
// PAYROLL & LEAVE MANAGEMENT
// ============================================================

export type PayrollRecord = {
  id: string;
  workerId: string;
  workerName: string;
  period: string;           // "2026-04"
  basicSalarySen: number;
  workingDays: number;
  otHoursWeekday: number;
  otHoursSunday: number;
  otHoursHoliday: number;
  otAmountSen: number;
  grossSalarySen: number;
  epfEmployeeSen: number;   // 11%
  epfEmployerSen: number;   // 13%
  socsoEmployeeSen: number;
  socsoEmployerSen: number;
  eisEmployeeSen: number;
  eisEmployerSen: number;
  pcbSen: number;           // tax deduction
  totalDeductionsSen: number;
  netPaySen: number;
  status: "DRAFT" | "APPROVED" | "PAID";
};

export type LeaveRecord = {
  id: string;
  workerId: string;
  workerName: string;
  type: "ANNUAL" | "MEDICAL" | "UNPAID" | "EMERGENCY" | "PUBLIC_HOLIDAY";
  startDate: string;
  endDate: string;
  days: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string;
  approvedBy?: string;
};

let _payrollIdCounter = 1;
export function getNextPayrollId(): string {
  return `PAY-${String(_payrollIdCounter++).padStart(5, "0")}`;
}

// Mock payroll records (March 2026)
export const payrollRecords: PayrollRecord[] = [];

// Mock leave records
export const leaveRecords: LeaveRecord[] = [];

// ============================================================
// EQUIPMENT & MAINTENANCE
// ============================================================

export type Equipment = {
  id: string;
  code: string;
  name: string;
  department: string;
  type: "SEWING_MACHINE" | "CUTTING_TABLE" | "STAPLE_GUN" | "COMPRESSOR" | "SAW" | "DRILL" | "OTHER";
  status: "OPERATIONAL" | "MAINTENANCE" | "REPAIR" | "DECOMMISSIONED";
  lastMaintenanceDate: string;
  nextMaintenanceDate: string;
  maintenanceCycleDays: number;
  purchaseDate: string;
  notes: string;
};

export type MaintenanceLog = {
  id: string;
  equipmentId: string;
  equipmentName: string;
  type: "PREVENTIVE" | "CORRECTIVE" | "EMERGENCY";
  description: string;
  performedBy: string;
  date: string;
  costSen: number;
  downtimeHours: number;
};

export const equipmentList: Equipment[] = [];

export const maintenanceLogs: MaintenanceLog[] = [];

// --- Notifications ---
export type Notification = {
  id: string;
  type: "ORDER" | "PRODUCTION" | "INVENTORY" | "DELIVERY" | "QUALITY" | "FINANCE" | "SYSTEM";
  title: string;
  message: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  isRead: boolean;
  link?: string;
  createdAt: string;
};

export const notifications: Notification[] = [
  {
    id: "notif-001", type: "ORDER", title: "New Sales Order Received",
    message: "SO-2604-045 received from HOUZS KL - 8 items totalling RM 18,500.00",
    severity: "INFO", isRead: false, link: "/sales/SO-2604-045", createdAt: "2026-04-14T09:30:00",
  },
  {
    id: "notif-002", type: "INVENTORY", title: "Low Stock Alert",
    message: "Premium Black Fabric below reorder point - 12 meters remaining (min: 50)",
    severity: "WARNING", isRead: false, link: "/inventory", createdAt: "2026-04-14T08:45:00",
  },
  {
    id: "notif-003", type: "PRODUCTION", title: "Production Order Overdue",
    message: "PO-INT-2604-012 is 3 days overdue - assigned to Upholstery department",
    severity: "CRITICAL", isRead: false, link: "/production", createdAt: "2026-04-14T08:00:00",
  },
  {
    id: "notif-004", type: "QUALITY", title: "QC Failed",
    message: "SO-2604-043-02 failed quality check at Upholstery checkpoint - fabric alignment issue",
    severity: "WARNING", isRead: false, link: "/quality", createdAt: "2026-04-14T07:30:00",
  },
  {
    id: "notif-005", type: "FINANCE", title: "Invoice Overdue",
    message: "INV-2604-008 from CARRESS SDN BHD is overdue by 15 days - RM 7,950.00",
    severity: "WARNING", isRead: false, link: "/finance/invoices", createdAt: "2026-04-14T07:00:00",
  },
  {
    id: "notif-006", type: "DELIVERY", title: "Delivery Confirmed",
    message: "DO-2604-005 confirmed arrived at HOUZS PG - signed by warehouse manager",
    severity: "INFO", isRead: false, link: "/delivery", createdAt: "2026-04-13T16:30:00",
  },
  {
    id: "notif-007", type: "PRODUCTION", title: "Batch Completed",
    message: "Batch B2604-018 has completed all 8 departments - ready for packing",
    severity: "INFO", isRead: false, link: "/production", createdAt: "2026-04-13T15:00:00",
  },
  {
    id: "notif-008", type: "SYSTEM", title: "System Backup Complete",
    message: "Daily system backup completed successfully at 02:00 AM - all data secured",
    severity: "INFO", isRead: true, link: undefined, createdAt: "2026-04-13T02:00:00",
  },
  {
    id: "notif-009", type: "INVENTORY", title: "Stock Received",
    message: "GRN processed for PO-2604-016 from Foam Industries M'sia - 200 units",
    severity: "INFO", isRead: true, link: "/inventory", createdAt: "2026-04-13T11:30:00",
  },
  {
    id: "notif-010", type: "ORDER", title: "Sales Order Shipped",
    message: "SO-2604-042 shipped to THE CONTS SDN BHD via J&T Express - tracking #JT20260413",
    severity: "INFO", isRead: true, link: "/sales/SO-2604-042", createdAt: "2026-04-13T10:00:00",
  },
  {
    id: "notif-011", type: "QUALITY", title: "QC Inspection Passed",
    message: "Batch B2604-015 passed final QC inspection - all 12 items cleared",
    severity: "INFO", isRead: true, link: "/quality", createdAt: "2026-04-12T16:45:00",
  },
  {
    id: "notif-012", type: "PRODUCTION", title: "Machine Maintenance Required",
    message: "Industrial Sewing Machine EQ-UPH-001 maintenance overdue by 5 days",
    severity: "CRITICAL", isRead: false, link: "/production", createdAt: "2026-04-12T14:00:00",
  },
  {
    id: "notif-013", type: "FINANCE", title: "Payment Received",
    message: "RM 12,350.00 received from DREAMSCAPE LIVING for INV-2604-003",
    severity: "INFO", isRead: true, link: "/finance/invoices", createdAt: "2026-04-12T11:00:00",
  },
  {
    id: "notif-014", type: "DELIVERY", title: "Delivery Scheduled",
    message: "DO-2604-008 scheduled for delivery to ZARA HOME KL on 2026-04-16",
    severity: "INFO", isRead: true, link: "/delivery", createdAt: "2026-04-12T09:30:00",
  },
  {
    id: "notif-015", type: "INVENTORY", title: "Reorder Alert",
    message: "Packing Box (King) critically low - 10 units remaining (reorder level: 50)",
    severity: "CRITICAL", isRead: false, link: "/inventory", createdAt: "2026-04-11T08:15:00",
  },
  {
    id: "notif-016", type: "ORDER", title: "Order On Hold",
    message: "SO-2604-039 placed on hold - pending credit approval for LUMINA DECOR",
    severity: "WARNING", isRead: true, link: "/sales/SO-2604-039", createdAt: "2026-04-11T07:00:00",
  },
  {
    id: "notif-017", type: "SYSTEM", title: "User Access Updated",
    message: "New user Tan Mei Ling granted QC Inspector role access",
    severity: "INFO", isRead: true, link: undefined, createdAt: "2026-04-10T15:45:00",
  },
  {
    id: "notif-018", type: "FINANCE", title: "Credit Limit Warning",
    message: "LUMINA DECOR approaching credit limit - RM 45,000 / RM 50,000 utilized",
    severity: "WARNING", isRead: true, link: "/finance", createdAt: "2026-04-10T10:00:00",
  },
];

// --- Organisations ---
export type Organisation = {
  id: string;
  code: "HOOKKA" | "OHANA";
  name: string;
  regNo: string;
  tin: string;
  msic: string;
  address: string;
  phone: string;
  email: string;
  transferPricingPct: number;
  isActive: boolean;
};

export type InterCompanyConfig = {
  hookkaToOhanaRate: number;
  autoCreateMirrorDocs: boolean;
};

export const organisations: Organisation[] = [
  {
    id: "org-hookka",
    code: "HOOKKA",
    name: "HOOKKA INDUSTRIES SDN BHD",
    regNo: "202501060540 (1661946-X)",
    tin: "C60515534080",
    msic: "31009",
    address: "2775F, Jalan Industri 12, Kampung Baru Sungai Buloh, 47000 Sungai Buloh, Selangor",
    phone: "+6011-6133 3173",
    email: "finance@hookka.com",
    transferPricingPct: 65,
    isActive: true,
  },
  {
    id: "org-ohana",
    code: "OHANA",
    name: "OHANA MARKETING SDN BHD",
    regNo: "202501058806 (1660212-M)",
    tin: "C60508048080",
    msic: "47591",
    address: "The Nest Residence, A-28-07 Jalan A Off, Jalan Puchong, 58200 Kuala Lumpur",
    phone: "+6010-233 1323",
    email: "ohanastudio99@gmail.com",
    transferPricingPct: 0,
    isActive: true,
  },
];

// ============================================================
// E-INVOICES (LHDN MyInvois)
// ============================================================

export type EInvoice = {
  id: string;
  invoiceId: string;
  invoiceNo: string;
  customerName: string;
  customerTIN?: string;
  submissionId?: string;
  uuid?: string;
  status: "PENDING" | "SUBMITTED" | "VALID" | "INVALID" | "CANCELLED";
  submittedAt?: string;
  validatedAt?: string;
  errorMessage?: string;
  xmlContent?: string;
  totalExcludingTax: number;
  taxAmount: number;
  totalIncludingTax: number;
  createdAt: string;
};

export function generateEInvoiceXml(invoiceNo: string, issueDate: string, customerName: string, customerTIN: string | undefined, totalExcludingTax: number, taxAmount: number, totalIncludingTax: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <ID>${invoiceNo}</ID>
  <IssueDate>${issueDate}</IssueDate>
  <InvoiceTypeCode listVersionID="1.0">01</InvoiceTypeCode>
  <DocumentCurrencyCode>MYR</DocumentCurrencyCode>
  <AccountingSupplierParty>
    <Party>
      <PartyIdentification>
        <ID schemeID="TIN">C60515534080</ID>
      </PartyIdentification>
      <PartyIdentification>
        <ID schemeID="BRN">202501060540</ID>
      </PartyIdentification>
      <PartyName>
        <Name>HOOKKA INDUSTRIES SDN BHD</Name>
      </PartyName>
      <PostalAddress>
        <CityName>Shah Alam</CityName>
        <CountrySubentityCode>10</CountrySubentityCode>
        <Country>
          <IdentificationCode>MYS</IdentificationCode>
        </Country>
      </PostalAddress>
      <PartyTaxScheme>
        <CompanyID>C60515534080</CompanyID>
        <TaxScheme>
          <ID>OTH</ID>
        </TaxScheme>
      </PartyTaxScheme>
    </Party>
  </AccountingSupplierParty>
  <AccountingCustomerParty>
    <Party>
      <PartyIdentification>
        <ID schemeID="TIN">${customerTIN || "EI00000000010"}</ID>
      </PartyIdentification>
      <PartyName>
        <Name>${customerName}</Name>
      </PartyName>
    </Party>
  </AccountingCustomerParty>
  <TaxTotal>
    <TaxAmount currencyID="MYR">${taxAmount.toFixed(2)}</TaxAmount>
    <TaxSubtotal>
      <TaxableAmount currencyID="MYR">${totalExcludingTax.toFixed(2)}</TaxableAmount>
      <TaxAmount currencyID="MYR">${taxAmount.toFixed(2)}</TaxAmount>
      <TaxCategory>
        <ID>01</ID>
        <Percent>10</Percent>
        <TaxScheme>
          <ID>OTH</ID>
        </TaxScheme>
      </TaxCategory>
    </TaxSubtotal>
  </TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount currencyID="MYR">${totalExcludingTax.toFixed(2)}</TaxExclusiveAmount>
    <TaxInclusiveAmount currencyID="MYR">${totalIncludingTax.toFixed(2)}</TaxInclusiveAmount>
    <PayableAmount currencyID="MYR">${totalIncludingTax.toFixed(2)}</PayableAmount>
  </LegalMonetaryTotal>
  <InvoiceLine>
    <ID>1</ID>
    <InvoicedQuantity unitCode="C62">1</InvoicedQuantity>
    <LineExtensionAmount currencyID="MYR">${totalExcludingTax.toFixed(2)}</LineExtensionAmount>
    <TaxTotal>
      <TaxAmount currencyID="MYR">${taxAmount.toFixed(2)}</TaxAmount>
    </TaxTotal>
    <Item>
      <Description>Consolidated invoice line</Description>
    </Item>
    <Price>
      <PriceAmount currencyID="MYR">${totalExcludingTax.toFixed(2)}</PriceAmount>
    </Price>
  </InvoiceLine>
</Invoice>`;
}

export const eInvoices: EInvoice[] = [
  {
    id: "einv-1",
    invoiceId: "inv-1",
    invoiceNo: "INV-2604-028",
    customerName: "The Conts",
    customerTIN: "C20987654030",
    submissionId: "LHDN-SUB-20260416-001",
    uuid: "F9D425P6DS7D8IU",
    status: "VALID",
    submittedAt: "2026-04-16T16:00:00Z",
    validatedAt: "2026-04-16T16:05:00Z",
    xmlContent: generateEInvoiceXml("INV-2604-028", "2026-04-16", "THE CONTS SDN BHD", "C20987654030", 5818.18, 581.82, 6400.00),
    totalExcludingTax: 5818.18,
    taxAmount: 581.82,
    totalIncludingTax: 6400.00,
    createdAt: "2026-04-16T15:30:00Z",
  },
  {
    id: "einv-2",
    invoiceId: "inv-2",
    invoiceNo: "INV-2604-027",
    customerName: "Houzs Century",
    customerTIN: "C10876543020",
    submissionId: "LHDN-SUB-20260414-002",
    uuid: "A7B324K9MN2H5QR",
    status: "SUBMITTED",
    submittedAt: "2026-04-14T09:00:00Z",
    xmlContent: generateEInvoiceXml("INV-2604-027", "2026-04-13", "HOUZS KL", "C10876543020", 7763.64, 776.36, 8540.00),
    totalExcludingTax: 7763.64,
    taxAmount: 776.36,
    totalIncludingTax: 8540.00,
    createdAt: "2026-04-14T08:30:00Z",
  },
  {
    id: "einv-3",
    invoiceId: "",
    invoiceNo: "INV-2604-025",
    customerName: "DERA FURNISHING",
    customerTIN: "C30765432010",
    status: "PENDING",
    xmlContent: generateEInvoiceXml("INV-2604-025", "2026-04-10", "DERA FURNISHING", "C30765432010", 3636.36, 363.64, 4000.00),
    totalExcludingTax: 3636.36,
    taxAmount: 363.64,
    totalIncludingTax: 4000.00,
    createdAt: "2026-04-10T14:00:00Z",
  },
  {
    id: "einv-4",
    invoiceId: "",
    invoiceNo: "INV-2604-022",
    customerName: "STAR LIVING JB",
    submissionId: "LHDN-SUB-20260408-003",
    uuid: "X4C891D3FG7J2KL",
    status: "INVALID",
    submittedAt: "2026-04-08T10:00:00Z",
    errorMessage: "Invalid TIN format for buyer. Please verify customer TIN and resubmit.",
    xmlContent: generateEInvoiceXml("INV-2604-022", "2026-04-07", "STAR LIVING JB", undefined, 12727.27, 1272.73, 14000.00),
    totalExcludingTax: 12727.27,
    taxAmount: 1272.73,
    totalIncludingTax: 14000.00,
    createdAt: "2026-04-07T16:00:00Z",
  },
  {
    id: "einv-5",
    invoiceId: "",
    invoiceNo: "INV-2604-020",
    customerName: "DREAMHOME INTERIORS",
    customerTIN: "C40654321090",
    submissionId: "LHDN-SUB-20260405-004",
    uuid: "M2N567P8QR1S3TU",
    status: "CANCELLED",
    submittedAt: "2026-04-05T11:00:00Z",
    validatedAt: "2026-04-05T11:03:00Z",
    xmlContent: generateEInvoiceXml("INV-2604-020", "2026-04-04", "DREAMHOME INTERIORS", "C40654321090", 9090.91, 909.09, 10000.00),
    totalExcludingTax: 9090.91,
    taxAmount: 909.09,
    totalIncludingTax: 10000.00,
    createdAt: "2026-04-04T09:00:00Z",
  },
  {
    id: "einv-6",
    invoiceId: "",
    invoiceNo: "INV-2604-018",
    customerName: "CASA DECOR PENANG",
    customerTIN: "C50543210080",
    submissionId: "LHDN-SUB-20260412-005",
    uuid: "V8W901X2YZ3A4BC",
    status: "VALID",
    submittedAt: "2026-04-12T14:00:00Z",
    validatedAt: "2026-04-12T14:04:00Z",
    xmlContent: generateEInvoiceXml("INV-2604-018", "2026-04-11", "CASA DECOR PENANG", "C50543210080", 6363.64, 636.36, 7000.00),
    totalExcludingTax: 6363.64,
    taxAmount: 636.36,
    totalIncludingTax: 7000.00,
    createdAt: "2026-04-11T10:00:00Z",
  },
  {
    id: "einv-7",
    invoiceId: "",
    invoiceNo: "INV-2602-005",
    customerName: "Houzs KL",
    customerTIN: "C10876543020",
    submissionId: "LHDN-SUB-20260201-007",
    uuid: "K3L892M5NP7Q8RS",
    status: "VALID",
    submittedAt: "2026-02-01T10:00:00Z",
    validatedAt: "2026-02-01T10:04:00Z",
    xmlContent: generateEInvoiceXml("INV-2602-005", "2026-01-30", "HOUZS KL", "C10876543020", 5090.91, 509.09, 5600.00),
    totalExcludingTax: 5090.91,
    taxAmount: 509.09,
    totalIncludingTax: 5600.00,
    createdAt: "2026-02-01T09:30:00Z",
  },
  {
    id: "einv-8",
    invoiceId: "",
    invoiceNo: "INV-2602-012",
    customerName: "Carress",
    customerTIN: "C20111222030",
    submissionId: "LHDN-SUB-20260206-008",
    uuid: "B2C345D6EF7G8HI",
    status: "VALID",
    submittedAt: "2026-02-06T09:30:00Z",
    validatedAt: "2026-02-06T09:33:00Z",
    xmlContent: generateEInvoiceXml("INV-2602-012", "2026-02-05", "CARRESS SDN BHD", "C20111222030", 7272.73, 727.27, 8000.00),
    totalExcludingTax: 7272.73,
    taxAmount: 727.27,
    totalIncludingTax: 8000.00,
    createdAt: "2026-02-06T09:00:00Z",
  },
  {
    id: "einv-9",
    invoiceId: "",
    invoiceNo: "INV-2602-018",
    customerName: "Houzs PG",
    customerTIN: "C10876543020",
    submissionId: "LHDN-SUB-20260225-009",
    uuid: "J4K567L8MN9O0PQ",
    status: "SUBMITTED",
    submittedAt: "2026-02-25T11:00:00Z",
    xmlContent: generateEInvoiceXml("INV-2602-018", "2026-02-25", "HOUZS PG", "C10876543020", 4727.27, 472.73, 5200.00),
    totalExcludingTax: 4727.27,
    taxAmount: 472.73,
    totalIncludingTax: 5200.00,
    createdAt: "2026-02-25T10:30:00Z",
  },
  {
    id: "einv-10",
    invoiceId: "",
    invoiceNo: "INV-2602-022",
    customerName: "The Conts",
    customerTIN: "C20987654030",
    submissionId: "LHDN-SUB-20260228-010",
    uuid: "R5S678T9UV0W1XY",
    status: "VALID",
    submittedAt: "2026-02-28T14:30:00Z",
    validatedAt: "2026-02-28T14:34:00Z",
    xmlContent: generateEInvoiceXml("INV-2602-022", "2026-02-28", "THE CONTS SDN BHD", "C20987654030", 13818.18, 1381.82, 15200.00),
    totalExcludingTax: 13818.18,
    taxAmount: 1381.82,
    totalIncludingTax: 15200.00,
    createdAt: "2026-02-28T14:00:00Z",
  },
  {
    id: "einv-11",
    invoiceId: "",
    invoiceNo: "INV-2603-008",
    customerName: "Houzs PG",
    customerTIN: "C10876543020",
    status: "PENDING",
    xmlContent: generateEInvoiceXml("INV-2603-008", "2026-03-12", "HOUZS PG", "C10876543020", 4727.27, 472.73, 5200.00),
    totalExcludingTax: 4727.27,
    taxAmount: 472.73,
    totalIncludingTax: 5200.00,
    createdAt: "2026-03-12T09:00:00Z",
  },
  {
    id: "einv-12",
    invoiceId: "",
    invoiceNo: "INV-2603-014",
    customerName: "Carress",
    customerTIN: "C20111222030",
    submissionId: "LHDN-SUB-20260321-012",
    uuid: "F3G890H1IJ2K3LM",
    status: "INVALID",
    submittedAt: "2026-03-21T15:00:00Z",
    errorMessage: "Line item tax amount mismatch. Resubmit required.",
    xmlContent: generateEInvoiceXml("INV-2603-014", "2026-03-20", "CARRESS SDN BHD", "C20111222030", 10909.09, 1090.91, 12000.00),
    totalExcludingTax: 10909.09,
    taxAmount: 1090.91,
    totalIncludingTax: 12000.00,
    createdAt: "2026-03-21T14:30:00Z",
  },
  {
    id: "einv-13",
    invoiceId: "",
    invoiceNo: "INV-2604-005",
    customerName: "Houzs SRW",
    customerTIN: "C10876543020",
    submissionId: "LHDN-SUB-20260402-013",
    uuid: "N6O123P4QR5S6TU",
    status: "VALID",
    submittedAt: "2026-04-02T11:30:00Z",
    validatedAt: "2026-04-02T11:34:00Z",
    xmlContent: generateEInvoiceXml("INV-2604-005", "2026-04-02", "HOUZS SRW", "C10876543020", 4000.00, 400.00, 4400.00),
    totalExcludingTax: 4000.00,
    taxAmount: 400.00,
    totalIncludingTax: 4400.00,
    createdAt: "2026-04-02T11:00:00Z",
  },
  {
    id: "einv-14",
    invoiceId: "",
    invoiceNo: "INV-2604-011",
    customerName: "Carress",
    customerTIN: "C20111222030",
    status: "PENDING",
    xmlContent: generateEInvoiceXml("INV-2604-011", "2026-04-09", "CARRESS SDN BHD", "C20111222030", 3636.36, 363.64, 4000.00),
    totalExcludingTax: 3636.36,
    taxAmount: 363.64,
    totalIncludingTax: 4000.00,
    createdAt: "2026-04-09T10:00:00Z",
  },
  {
    id: "einv-15",
    invoiceId: "",
    invoiceNo: "INV-2604-016",
    customerName: "The Conts",
    customerTIN: "C20987654030",
    submissionId: "LHDN-SUB-20260412-015",
    uuid: "W7X234Y5ZA6B7CD",
    status: "SUBMITTED",
    submittedAt: "2026-04-12T16:00:00Z",
    xmlContent: generateEInvoiceXml("INV-2604-016", "2026-04-12", "THE CONTS SDN BHD", "C20987654030", 8909.09, 890.91, 9800.00),
    totalExcludingTax: 8909.09,
    taxAmount: 890.91,
    totalIncludingTax: 9800.00,
    createdAt: "2026-04-12T15:30:00Z",
  },
];

export let activeOrgId = "org-hookka";
export function setActiveOrgId(id: string) { activeOrgId = id; }
export const interCompanyConfig: InterCompanyConfig = { hookkaToOhanaRate: 0.65, autoCreateMirrorDocs: true };

// ============================================================
// MRP - Material Requirements Planning
// ============================================================

export type MaterialRequirement = {
  id: string;
  materialName: string;
  materialCategory: string;
  unit: string;
  grossRequired: number;
  onHand: number;
  onOrder: number;
  netRequired: number;
  status: "SUFFICIENT" | "LOW" | "SHORTAGE";
  suggestedPOQty: number;
  preferredSupplierId?: string;
  preferredSupplierName?: string;
};

export type MRPRun = {
  id: string;
  runDate: string;
  planningHorizon: string;
  productionOrderCount: number;
  totalMaterials: number;
  shortageCount: number;
  status: "COMPLETED" | "IN_PROGRESS";
  requirements: MaterialRequirement[];
};

export const mrpRuns: MRPRun[] = [];

// --- Bank Accounts & Transactions (Cash Flow module) ---
export type BankAccount = {
  id: string;
  bankName: string;
  accountNo: string;
  accountName: string;
  balanceSen: number;
  currency: string;
};

export type BankTransaction = {
  id: string;
  bankAccountId: string;
  date: string;
  description: string;
  amountSen: number; // positive = deposit, negative = withdrawal
  type: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";
  reference: string;
  isReconciled: boolean;
  matchedJournalId?: string;
};

export const bankAccounts: BankAccount[] = [];

export const bankTransactions: BankTransaction[] = [];

// --- Approval Requests ---
export type ApprovalRequest = {
  id: string;
  type: "PRICE_OVERRIDE" | "DISCOUNT" | "PO_APPROVAL" | "LEAVE_REQUEST" | "STOCK_ADJUSTMENT" | "CREDIT_OVERRIDE" | "SO_CANCELLATION";
  referenceNo: string;
  referenceId: string;
  title: string;
  description: string;
  requestedBy: string;
  requestedAt: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  approvedBy?: string;
  approvedAt?: string;
  reason?: string;
  amountSen?: number;
  metadata?: Record<string, string>;
};

export const approvalRequests: ApprovalRequest[] = [];

// ============================================================
// SUPPLIER MULTI-SKU & PRICE MANAGEMENT
// ============================================================

export type SupplierMaterialBinding = {
  id: string;
  supplierId: string;
  materialCode: string;
  materialName: string;
  supplierSku: string;
  unitPrice: number; // sen
  currency: "MYR" | "RMB";
  leadTimeDays: number;
  paymentTerms: string;
  moq: number;
  priceValidFrom: string;
  priceValidTo: string;
  isMainSupplier: boolean;
};

export type PriceHistory = {
  id: string;
  bindingId: string;
  supplierId: string;
  materialCode: string;
  oldPrice: number; // sen
  newPrice: number; // sen
  currency: "MYR" | "RMB";
  changedDate: string;
  changedBy: string;
  reason: string;
  approvalStatus: "APPROVED" | "PENDING" | "REJECTED";
};

export type SupplierScorecard = {
  supplierId: string;
  onTimeRate: number; // 0-100
  qualityRate: number; // 0-100
  leadTimeAccuracy: number; // 0-100
  avgPriceTrend: number; // %
  overallRating: number; // 1-5
  lastUpdated: string;
};

export const supplierMaterialBindings: SupplierMaterialBinding[] = [
  {
    id: "smb-1", supplierId: "sup-1", materialCode: "FAB-BM-001", materialName: "PC151 Dark Grey Body Fabric",
    supplierSku: "KU-PC151", unitPrice: 2500, currency: "MYR", leadTimeDays: 7,
    paymentTerms: "NET30", moq: 100, priceValidFrom: "2026-01-01", priceValidTo: "2026-06-30", isMainSupplier: true,
  },
  {
    id: "smb-2", supplierId: "sup-1", materialCode: "FAB-BM-002", materialName: "PC200 Charcoal Body Fabric",
    supplierSku: "KU-PC200", unitPrice: 2600, currency: "MYR", leadTimeDays: 7,
    paymentTerms: "NET30", moq: 100, priceValidFrom: "2026-01-01", priceValidTo: "2026-06-30", isMainSupplier: true,
  },
  {
    id: "smb-3", supplierId: "sup-1", materialCode: "FAB-SM-001", materialName: "VL100 Taupe Show Fabric",
    supplierSku: "KU-VL100", unitPrice: 3000, currency: "MYR", leadTimeDays: 10,
    paymentTerms: "NET30", moq: 50, priceValidFrom: "2026-01-01", priceValidTo: "2026-06-30", isMainSupplier: true,
  },
  {
    id: "smb-4", supplierId: "sup-2", materialCode: "WD-PLY-001", materialName: "Plywood 12mm",
    supplierSku: "PJ-PLY-12", unitPrice: 4500, currency: "MYR", leadTimeDays: 5,
    paymentTerms: "NET30", moq: 50, priceValidFrom: "2026-01-01", priceValidTo: "2026-12-31", isMainSupplier: true,
  },
  {
    id: "smb-5", supplierId: "sup-2", materialCode: "WD-PLY-002", materialName: "Plywood 18mm",
    supplierSku: "PJ-PLY-18", unitPrice: 6200, currency: "MYR", leadTimeDays: 5,
    paymentTerms: "NET30", moq: 30, priceValidFrom: "2026-01-01", priceValidTo: "2026-12-31", isMainSupplier: true,
  },
  {
    id: "smb-6", supplierId: "sup-3", materialCode: "FM-HD-001", materialName: "High Density Foam 25mm",
    supplierSku: "FI-HDF-25", unitPrice: 3500, currency: "MYR", leadTimeDays: 3,
    paymentTerms: "NET14", moq: 20, priceValidFrom: "2026-01-01", priceValidTo: "2026-06-30", isMainSupplier: true,
  },
  {
    id: "smb-7", supplierId: "sup-4", materialCode: "ACC-LEG-001", materialName: "Metal Leg 6 inch",
    supplierSku: "HP-LEG-06", unitPrice: 1200, currency: "MYR", leadTimeDays: 7,
    paymentTerms: "NET30", moq: 50, priceValidFrom: "2026-01-01", priceValidTo: "2026-12-31", isMainSupplier: true,
  },
  {
    id: "smb-8", supplierId: "sup-5", materialCode: "PK-CB-001", materialName: "Carton Box King",
    supplierSku: "PS-CB-K", unitPrice: 1500, currency: "MYR", leadTimeDays: 3,
    paymentTerms: "NET14", moq: 50, priceValidFrom: "2026-01-01", priceValidTo: "2026-12-31", isMainSupplier: true,
  },
  {
    id: "smb-9", supplierId: "sup-3", materialCode: "FM-HD-001", materialName: "High Density Foam 25mm",
    supplierSku: "FI-HDF-25-ALT", unitPrice: 3600, currency: "MYR", leadTimeDays: 5,
    paymentTerms: "NET30", moq: 10, priceValidFrom: "2026-01-01", priceValidTo: "2026-06-30", isMainSupplier: false,
  },
  {
    id: "smb-10", supplierId: "sup-4", materialCode: "FAB-BM-001", materialName: "PC151 Dark Grey Body Fabric",
    supplierSku: "HP-FAB-151", unitPrice: 2700, currency: "MYR", leadTimeDays: 14,
    paymentTerms: "NET30", moq: 50, priceValidFrom: "2026-01-01", priceValidTo: "2026-06-30", isMainSupplier: false,
  },
];

export const priceHistories: PriceHistory[] = [
  {
    id: "ph-1", bindingId: "smb-1", supplierId: "sup-1", materialCode: "FAB-BM-001",
    oldPrice: 2400, newPrice: 2500, currency: "MYR",
    changedDate: "2026-01-15", changedBy: "Ahmad Razak", reason: "Annual price revision",
    approvalStatus: "APPROVED",
  },
  {
    id: "ph-2", bindingId: "smb-4", supplierId: "sup-2", materialCode: "WD-PLY-001",
    oldPrice: 4200, newPrice: 4500, currency: "MYR",
    changedDate: "2026-02-01", changedBy: "Lim Hock", reason: "Raw material cost increase",
    approvalStatus: "APPROVED",
  },
  {
    id: "ph-3", bindingId: "smb-6", supplierId: "sup-3", materialCode: "FM-HD-001",
    oldPrice: 3200, newPrice: 3500, currency: "MYR",
    changedDate: "2026-03-10", changedBy: "Puan Noraini", reason: "Petroleum-based input cost increase",
    approvalStatus: "APPROVED",
  },
  {
    id: "ph-4", bindingId: "smb-7", supplierId: "sup-4", materialCode: "ACC-LEG-001",
    oldPrice: 1200, newPrice: 1350, currency: "MYR",
    changedDate: "2026-04-01", changedBy: "Tan Kah Wai", reason: "Steel price hike Q2",
    approvalStatus: "PENDING",
  },
  {
    id: "ph-5", bindingId: "smb-3", supplierId: "sup-1", materialCode: "FAB-SM-001",
    oldPrice: 3200, newPrice: 3000, currency: "MYR",
    changedDate: "2026-03-01", changedBy: "Ahmad Razak", reason: "Volume discount negotiation",
    approvalStatus: "APPROVED",
  },
  {
    id: "ph-6", bindingId: "smb-8", supplierId: "sup-5", materialCode: "PK-CB-001",
    oldPrice: 1500, newPrice: 1650, currency: "MYR",
    changedDate: "2026-04-10", changedBy: "Encik Faizal", reason: "Paper cost increase",
    approvalStatus: "REJECTED",
  },
];

export const supplierScorecards: SupplierScorecard[] = [
  { supplierId: "sup-1", onTimeRate: 95, qualityRate: 98, leadTimeAccuracy: 92, avgPriceTrend: 4.2, overallRating: 5, lastUpdated: "2026-04-01" },
  { supplierId: "sup-2", onTimeRate: 88, qualityRate: 94, leadTimeAccuracy: 85, avgPriceTrend: 7.1, overallRating: 4, lastUpdated: "2026-04-01" },
  { supplierId: "sup-3", onTimeRate: 82, qualityRate: 90, leadTimeAccuracy: 78, avgPriceTrend: 9.4, overallRating: 4, lastUpdated: "2026-04-01" },
  { supplierId: "sup-4", onTimeRate: 75, qualityRate: 85, leadTimeAccuracy: 70, avgPriceTrend: 12.5, overallRating: 3, lastUpdated: "2026-04-01" },
  { supplierId: "sup-5", onTimeRate: 97, qualityRate: 99, leadTimeAccuracy: 95, avgPriceTrend: 2.0, overallRating: 5, lastUpdated: "2026-04-01" },
];

// ============================================================
// STOCK VALUE MAINTENANCE (Section 4.19)
// ============================================================

export type StockAccount = {
  code: string;       // e.g. "330-9000"
  description: string;
  category: "FG" | "WIP" | "RAW_MATERIAL";
};

export type MonthlyStockValue = {
  id: string;
  period: string;     // "YYYY-MM" format
  accountCode: string;
  accountDescription: string;
  openingValue: number;  // sen
  purchasesValue: number;
  consumptionValue: number;
  closingValue: number;  // sen
  physicalCountValue: number | null;
  variancePercent: number | null;
  status: "DRAFT" | "REVIEWED" | "POSTED";
  postedDate: string | null;
  postedBy: string | null;
};

export const stockAccounts: StockAccount[] = [
  { code: "330-9000", description: "Finished Goods", category: "FG" },
  { code: "330-8000", description: "Work-in-Progress", category: "WIP" },
  { code: "330-0001", description: "B.M Fabric", category: "RAW_MATERIAL" },
  { code: "330-0002", description: "S Fabric", category: "RAW_MATERIAL" },
  { code: "330-0003", description: "S.M Fabric", category: "RAW_MATERIAL" },
  { code: "330-1001", description: "Plywood", category: "RAW_MATERIAL" },
  { code: "330-1002", description: "WD Strip", category: "RAW_MATERIAL" },
  { code: "330-2001", description: "B.Filler", category: "RAW_MATERIAL" },
  { code: "330-2002", description: "S.Filler", category: "RAW_MATERIAL" },
  { code: "330-3001", description: "Others", category: "RAW_MATERIAL" },
  { code: "330-3002", description: "Accessories", category: "RAW_MATERIAL" },
  { code: "330-3003", description: "Maintenance", category: "RAW_MATERIAL" },
  { code: "330-3004", description: "Mechanism", category: "RAW_MATERIAL" },
  { code: "330-3005", description: "Webbing", category: "RAW_MATERIAL" },
  { code: "330-3008", description: "S.Mechanism", category: "RAW_MATERIAL" },
  { code: "330-3009", description: "S.Webbing", category: "RAW_MATERIAL" },
  { code: "330-4000", description: "Packing Materials", category: "RAW_MATERIAL" },
];

export const monthlyStockValues: MonthlyStockValue[] = [
  // 2026-02
  { id: "msv-001", period: "2026-02", accountCode: "330-9000", accountDescription: "Finished Goods", openingValue: 85000000, purchasesValue: 0, consumptionValue: 32000000, closingValue: 53000000, physicalCountValue: 52500000, variancePercent: -0.94, status: "POSTED", postedDate: "2026-03-05T10:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-002", period: "2026-02", accountCode: "330-8000", accountDescription: "Work-in-Progress", openingValue: 24000000, purchasesValue: 0, consumptionValue: 18000000, closingValue: 6000000, physicalCountValue: 6100000, variancePercent: 1.67, status: "POSTED", postedDate: "2026-03-05T10:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-003", period: "2026-02", accountCode: "330-0001", accountDescription: "B.M Fabric", openingValue: 12000000, purchasesValue: 8500000, consumptionValue: 9200000, closingValue: 11300000, physicalCountValue: 11000000, variancePercent: -2.65, status: "POSTED", postedDate: "2026-03-05T10:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-004", period: "2026-02", accountCode: "330-0002", accountDescription: "S Fabric", openingValue: 9500000, purchasesValue: 6000000, consumptionValue: 7100000, closingValue: 8400000, physicalCountValue: 8350000, variancePercent: -0.60, status: "POSTED", postedDate: "2026-03-05T10:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-005", period: "2026-02", accountCode: "330-1001", accountDescription: "Plywood", openingValue: 7200000, purchasesValue: 4500000, consumptionValue: 5800000, closingValue: 5900000, physicalCountValue: 5700000, variancePercent: -3.39, status: "POSTED", postedDate: "2026-03-05T10:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-006", period: "2026-02", accountCode: "330-3002", accountDescription: "Accessories", openingValue: 3200000, purchasesValue: 1800000, consumptionValue: 2100000, closingValue: 2900000, physicalCountValue: 2880000, variancePercent: -0.69, status: "POSTED", postedDate: "2026-03-05T10:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-007", period: "2026-02", accountCode: "330-4000", accountDescription: "Packing Materials", openingValue: 2100000, purchasesValue: 1500000, consumptionValue: 1700000, closingValue: 1900000, physicalCountValue: 1890000, variancePercent: -0.53, status: "POSTED", postedDate: "2026-03-05T10:00:00+08:00", postedBy: "Encik Hakimi" },

  // 2026-03
  { id: "msv-008", period: "2026-03", accountCode: "330-9000", accountDescription: "Finished Goods", openingValue: 53000000, purchasesValue: 0, consumptionValue: 28000000, closingValue: 25000000, physicalCountValue: 24800000, variancePercent: -0.80, status: "POSTED", postedDate: "2026-04-04T09:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-009", period: "2026-03", accountCode: "330-8000", accountDescription: "Work-in-Progress", openingValue: 6000000, purchasesValue: 0, consumptionValue: 4500000, closingValue: 1500000, physicalCountValue: 1520000, variancePercent: 1.33, status: "POSTED", postedDate: "2026-04-04T09:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-010", period: "2026-03", accountCode: "330-0001", accountDescription: "B.M Fabric", openingValue: 11300000, purchasesValue: 9000000, consumptionValue: 10500000, closingValue: 9800000, physicalCountValue: 9650000, variancePercent: -1.53, status: "POSTED", postedDate: "2026-04-04T09:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-011", period: "2026-03", accountCode: "330-0002", accountDescription: "S Fabric", openingValue: 8400000, purchasesValue: 5500000, consumptionValue: 6800000, closingValue: 7100000, physicalCountValue: 7050000, variancePercent: -0.70, status: "POSTED", postedDate: "2026-04-04T09:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-012", period: "2026-03", accountCode: "330-1001", accountDescription: "Plywood", openingValue: 5900000, purchasesValue: 5000000, consumptionValue: 6200000, closingValue: 4700000, physicalCountValue: 4550000, variancePercent: -3.19, status: "POSTED", postedDate: "2026-04-04T09:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-013", period: "2026-03", accountCode: "330-3002", accountDescription: "Accessories", openingValue: 2900000, purchasesValue: 2000000, consumptionValue: 2300000, closingValue: 2600000, physicalCountValue: 2590000, variancePercent: -0.38, status: "POSTED", postedDate: "2026-04-04T09:00:00+08:00", postedBy: "Encik Hakimi" },
  { id: "msv-014", period: "2026-03", accountCode: "330-4000", accountDescription: "Packing Materials", openingValue: 1900000, purchasesValue: 1200000, consumptionValue: 1400000, closingValue: 1700000, physicalCountValue: 1680000, variancePercent: -1.18, status: "POSTED", postedDate: "2026-04-04T09:00:00+08:00", postedBy: "Encik Hakimi" },

  // 2026-04 (current month - DRAFT)
  { id: "msv-015", period: "2026-04", accountCode: "330-9000", accountDescription: "Finished Goods", openingValue: 25000000, purchasesValue: 0, consumptionValue: 15000000, closingValue: 10000000, physicalCountValue: null, variancePercent: null, status: "DRAFT", postedDate: null, postedBy: null },
  { id: "msv-016", period: "2026-04", accountCode: "330-8000", accountDescription: "Work-in-Progress", openingValue: 1500000, purchasesValue: 0, consumptionValue: 800000, closingValue: 700000, physicalCountValue: null, variancePercent: null, status: "DRAFT", postedDate: null, postedBy: null },
  { id: "msv-017", period: "2026-04", accountCode: "330-0001", accountDescription: "B.M Fabric", openingValue: 9800000, purchasesValue: 7500000, consumptionValue: 8200000, closingValue: 9100000, physicalCountValue: null, variancePercent: null, status: "DRAFT", postedDate: null, postedBy: null },
  { id: "msv-018", period: "2026-04", accountCode: "330-0002", accountDescription: "S Fabric", openingValue: 7100000, purchasesValue: 4800000, consumptionValue: 5500000, closingValue: 6400000, physicalCountValue: null, variancePercent: null, status: "DRAFT", postedDate: null, postedBy: null },
  { id: "msv-019", period: "2026-04", accountCode: "330-1001", accountDescription: "Plywood", openingValue: 4700000, purchasesValue: 3800000, consumptionValue: 4200000, closingValue: 4300000, physicalCountValue: null, variancePercent: null, status: "DRAFT", postedDate: null, postedBy: null },
  { id: "msv-020", period: "2026-04", accountCode: "330-3002", accountDescription: "Accessories", openingValue: 2600000, purchasesValue: 1500000, consumptionValue: 1800000, closingValue: 2300000, physicalCountValue: null, variancePercent: null, status: "DRAFT", postedDate: null, postedBy: null },
  { id: "msv-021", period: "2026-04", accountCode: "330-4000", accountDescription: "Packing Materials", openingValue: 1700000, purchasesValue: 1000000, consumptionValue: 1100000, closingValue: 1600000, physicalCountValue: null, variancePercent: null, status: "DRAFT", postedDate: null, postedBy: null },
];

// ============================================================
// CONSIGNMENT MANAGEMENT
// ============================================================

export type ConsignmentItemStatus = "AT_BRANCH" | "SOLD" | "RETURNED" | "DAMAGED";

export type ConsignmentItem = {
  id: string;
  productId: string;
  productName: string;
  productCode: string;
  quantity: number;
  unitPrice: number; // sen
  status: ConsignmentItemStatus;
  soldDate: string | null;
  returnedDate: string | null;
  // Per-line PO link (migration 0066). Null for legacy items + manually
  // entered items; populated when CN is created from Pending CN POs.
  productionOrderId?: string | null;
};

export type ConsignmentNote = {
  id: string;
  noteNumber: string; // CON-YYMM-XXX
  type: "OUT" | "RETURN";
  customerId: string;
  customerName: string;
  branchName: string;
  items: ConsignmentItem[];
  sentDate: string;
  status: "ACTIVE" | "PARTIALLY_SOLD" | "FULLY_SOLD" | "RETURNED" | "CLOSED";
  totalValue: number; // sen
  notes: string;
  // Carrier metadata (migration 0066). Mirrors DeliveryOrder fields.
  driverId?: string | null;
  driverName?: string;
  driverContactPerson?: string;
  driverPhone?: string;
  vehicleId?: string | null;
  vehicleNo?: string;
  vehicleType?: string;
  // Lifecycle timestamps (migration 0066). Stamped server-side on
  // status transitions PARTIALLY_SOLD / FULLY_SOLD / CLOSED.
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  acknowledgedAt?: string | null;
  // Linkage (migration 0066). consignmentOrderId is the parent CO;
  // hubId is the destination delivery branch.
  consignmentOrderId?: string | null;
  hubId?: string | null;
};

export const consignmentNotes: ConsignmentNote[] = [];

// ============================================================
// GOODS IN TRANSIT TRACKING (Section 4.31)
// ============================================================

export type TransitStatus = "ORDERED" | "SHIPPED" | "IN_TRANSIT" | "CUSTOMS" | "RECEIVED";

export type GoodsInTransit = {
  id: string;
  poId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  shippingMethod: "SEA" | "AIR" | "LAND" | "COURIER";
  containerNumber: string | null;
  trackingNumber: string | null;
  carrierName: string;
  status: TransitStatus;
  orderDate: string;
  shippedDate: string | null;
  expectedArrival: string;
  actualArrival: string | null;
  customsClearanceDate: string | null;
  customsStatus: "N/A" | "PENDING" | "CLEARED" | "HELD";
  currency: "MYR" | "RMB";
  productCost: number;
  shippingCost: number;
  customsDuty: number;
  exchangeRate: number | null;
  landedCost: number;
  items: { materialCode: string; materialName: string; quantity: number; unitCost: number }[];
  notes: string;
};

export const goodsInTransit: GoodsInTransit[] = [
  {
    id: "git-1",
    poId: "po-2",
    poNumber: "PO-2604-017",
    supplierId: "sup-2",
    supplierName: "Papan Jaya Trading",
    shippingMethod: "LAND",
    containerNumber: null,
    trackingNumber: "MY-TRK-20260410-001",
    carrierName: "Pos Laju",
    status: "IN_TRANSIT",
    orderDate: "2026-04-04",
    shippedDate: "2026-04-07",
    expectedArrival: "2026-04-12",
    actualArrival: null,
    customsClearanceDate: null,
    customsStatus: "N/A",
    currency: "MYR",
    productCost: 630000,
    shippingCost: 15000,
    customsDuty: 0,
    exchangeRate: null,
    landedCost: 645000,
    items: [
      { materialCode: "PJ-PLY-12", materialName: "Plywood 12mm", quantity: 80, unitCost: 4500 },
      { materialCode: "PJ-WDS-25", materialName: "Wood Strip 25mm", quantity: 150, unitCost: 1800 },
    ],
    notes: "Local delivery from Johor. Overdue - expected 12 April.",
  },
  {
    id: "git-2",
    poId: "po-ext-1",
    poNumber: "PO-2604-020",
    supplierId: "sup-1",
    supplierName: "Kain Utama Sdn Bhd",
    shippingMethod: "SEA",
    containerNumber: "CSLU2345678",
    trackingNumber: "COSCO-MY-20260320-88",
    carrierName: "COSCO Shipping",
    status: "CUSTOMS",
    orderDate: "2026-03-10",
    shippedDate: "2026-03-18",
    expectedArrival: "2026-04-15",
    actualArrival: null,
    customsClearanceDate: null,
    customsStatus: "PENDING",
    currency: "RMB",
    productCost: 4500000,
    shippingCost: 350000,
    customsDuty: 225000,
    exchangeRate: 0.66,
    landedCost: 5075000,
    items: [
      { materialCode: "KU-PC151", materialName: "PC151 Dark Grey (Bulk)", quantity: 500, unitCost: 5000 },
      { materialCode: "KU-PC200", materialName: "PC200 Charcoal (Bulk)", quantity: 400, unitCost: 5500 },
      { materialCode: "KU-VL100", materialName: "VL100 Taupe (Bulk)", quantity: 200, unitCost: 3500 },
    ],
    notes: "China sea freight. Arriving Port Klang, pending customs clearance.",
  },
  {
    id: "git-3",
    poId: "po-ext-2",
    poNumber: "PO-2604-021",
    supplierId: "sup-4",
    supplierName: "Hardware Plus Sdn Bhd",
    shippingMethod: "LAND",
    containerNumber: null,
    trackingNumber: "MY-TRK-20260412-003",
    carrierName: "J&T Express",
    status: "SHIPPED",
    orderDate: "2026-04-10",
    shippedDate: "2026-04-12",
    expectedArrival: "2026-04-16",
    actualArrival: null,
    customsClearanceDate: null,
    customsStatus: "N/A",
    currency: "MYR",
    productCost: 195000,
    shippingCost: 8000,
    customsDuty: 0,
    exchangeRate: null,
    landedCost: 203000,
    items: [
      { materialCode: "HP-LEG-06", materialName: "Sofa Leg 6 inch", quantity: 100, unitCost: 1200 },
      { materialCode: "HP-BOLT-SET", materialName: "Bolt Set", quantity: 200, unitCost: 350 },
    ],
    notes: "Local hardware shipment from Subang.",
  },
  {
    id: "git-4",
    poId: "po-ext-3",
    poNumber: "PO-2604-022",
    supplierId: "sup-3",
    supplierName: "Foam Industries M'sia Sdn Bhd",
    shippingMethod: "LAND",
    containerNumber: null,
    trackingNumber: "MY-TRK-20260408-002",
    carrierName: "Own Lorry",
    status: "RECEIVED",
    orderDate: "2026-04-05",
    shippedDate: "2026-04-06",
    expectedArrival: "2026-04-08",
    actualArrival: "2026-04-08",
    customsClearanceDate: null,
    customsStatus: "N/A",
    currency: "MYR",
    productCost: 256000,
    shippingCost: 5000,
    customsDuty: 0,
    exchangeRate: null,
    landedCost: 261000,
    items: [
      { materialCode: "FI-HDF-25", materialName: "HD Foam 25mm", quantity: 40, unitCost: 3500 },
      { materialCode: "FI-HDF-50", materialName: "HD Foam 50mm", quantity: 20, unitCost: 5800 },
    ],
    notes: "Delivered on time via own lorry.",
  },
  {
    id: "git-5",
    poId: "po-ext-4",
    poNumber: "PO-2604-023",
    supplierId: "sup-1",
    supplierName: "Kain Utama Sdn Bhd",
    shippingMethod: "SEA",
    containerNumber: "OOLU7654321",
    trackingNumber: "OOCL-MY-20260305-42",
    carrierName: "OOCL",
    status: "IN_TRANSIT",
    orderDate: "2026-02-28",
    shippedDate: "2026-03-05",
    expectedArrival: "2026-04-10",
    actualArrival: null,
    customsClearanceDate: null,
    customsStatus: "N/A",
    currency: "RMB",
    productCost: 8200000,
    shippingCost: 620000,
    customsDuty: 410000,
    exchangeRate: 0.66,
    landedCost: 9230000,
    items: [
      { materialCode: "KU-KN390", materialName: "KN390 Knit Fabric (Bulk)", quantity: 1000, unitCost: 4800 },
      { materialCode: "KU-PC151", materialName: "PC151 Dark Grey (Bulk)", quantity: 800, unitCost: 5000 },
    ],
    notes: "Overdue shipment from Guangzhou. Vessel delayed at Shenzhen port.",
  },
  {
    id: "git-6",
    poId: "po-ext-5",
    poNumber: "PO-2604-024",
    supplierId: "sup-5",
    supplierName: "Pack & Ship M'sia Sdn Bhd",
    shippingMethod: "COURIER",
    containerNumber: null,
    trackingNumber: "DHL-MY-20260413-99",
    carrierName: "DHL Express",
    status: "ORDERED",
    orderDate: "2026-04-13",
    shippedDate: null,
    expectedArrival: "2026-04-18",
    actualArrival: null,
    customsClearanceDate: null,
    customsStatus: "N/A",
    currency: "MYR",
    productCost: 125000,
    shippingCost: 12000,
    customsDuty: 0,
    exchangeRate: null,
    landedCost: 137000,
    items: [
      { materialCode: "PS-CB-K", materialName: "Carton Box King", quantity: 50, unitCost: 1500 },
      { materialCode: "PS-WRAP-100", materialName: "Stretch Wrap 100m", quantity: 20, unitCost: 2500 },
    ],
    notes: "Urgent packing material order.",
  },
  {
    id: "git-7",
    poId: "po-ext-6",
    poNumber: "PO-2604-025",
    supplierId: "sup-4",
    supplierName: "Hardware Plus Sdn Bhd",
    shippingMethod: "AIR",
    containerNumber: null,
    trackingNumber: "MH-CARGO-20260401-15",
    carrierName: "Malaysia Airlines Cargo",
    status: "CUSTOMS",
    orderDate: "2026-03-25",
    shippedDate: "2026-04-01",
    expectedArrival: "2026-04-05",
    actualArrival: null,
    customsClearanceDate: null,
    customsStatus: "HELD",
    currency: "RMB",
    productCost: 1800000,
    shippingCost: 280000,
    customsDuty: 180000,
    exchangeRate: 0.66,
    landedCost: 2260000,
    items: [
      { materialCode: "HP-LEG-08", materialName: "Sofa Leg 8 inch (Import)", quantity: 500, unitCost: 2400 },
      { materialCode: "HP-WEB-50", materialName: "Elastic Webbing 50mm (Import)", quantity: 300, unitCost: 1600 },
    ],
    notes: "Held at customs - documentation issue. Overdue.",
  },
];

// ============================================================
// DEMAND FORECASTING & ANALYTICS (Section 4.25)
// ============================================================

export type ForecastEntry = {
  id: string;
  productId: string;
  productName: string;
  productCode: string;
  period: string; // "YYYY-MM"
  forecastQty: number;
  actualQty: number | null;
  method: "SMA_3" | "SMA_6" | "WMA";
  confidence: number; // 0-100
  createdDate: string;
};

export type HistoricalSales = {
  productId: string;
  productCode: string;
  productName: string;
  period: string; // "YYYY-MM"
  quantity: number;
  revenue: number; // sen
  customerId: string;
  customerName: string;
};

export type PromiseDateCalc = {
  productId: string;
  currentQueueDays: number;
  materialAvailability: "IN_STOCK" | "PARTIAL" | "NEED_ORDER";
  estimatedCompletionDays: number;
  promiseDate: string;
};

export const historicalSales: HistoricalSales[] = [];

export const forecastEntries: ForecastEntry[] = [];

export const promiseDateCalcs: PromiseDateCalc[] = [];

// ============================================================
// R&D (Research & Development) Projects
// ============================================================

export type RDProjectStage = "CONCEPT" | "DESIGN" | "PROTOTYPE" | "TESTING" | "APPROVED" | "PRODUCTION_READY";

export type RDPrototypeType = "FABRIC_SEWING" | "FRAMING";

export type RDPrototype = {
  id: string;
  projectId: string;
  prototypeType: RDPrototypeType;
  version: string;
  description: string;
  materialsCost: number;
  labourHours: number;
  testResults: string;
  feedback: string;
  improvements: string;
  defects: string;
  createdDate: string;
};

export type RDBOMItem = {
  id: string;
  materialCode: string;
  materialName: string;
  qty: number;
  unit: string;
  unitCostSen: number;
};

export type RDMaterialIssuance = {
  id: string;
  rdProjectId: string;
  rdProjectCode: string;
  materialId: string;
  materialCode: string;
  materialName: string;
  qty: number;
  unit: string;
  unitCostSen: number;
  totalCostSen: number;
  issuedDate: string;
  issuedBy: string;
  notes: string;
};

export type RDLabourLog = {
  id: string;
  rdProjectId: string;
  workerName: string;
  department: string;
  hours: number;
  date: string;
  description: string;
};

export type RDProjectType = "DEVELOPMENT" | "IMPROVEMENT";

export type RDProject = {
  id: string;
  code: string;
  name: string;
  description: string;
  projectType: RDProjectType;
  productCategory: "BEDFRAME" | "SOFA" | "ACCESSORY";
  serviceId?: string;  // linked Return Case ID (for IMPROVEMENT type)
  currentStage: RDProjectStage;
  targetLaunchDate: string;
  assignedTeam: string[];
  milestones: { stage: RDProjectStage; targetDate: string; actualDate: string | null; approvedBy: string | null; photos?: string[] }[];
  totalBudget: number;
  actualCost: number;
  prototypes: RDPrototype[];
  productionBOM?: RDBOMItem[];
  materialIssuances?: RDMaterialIssuance[];
  labourLogs?: RDLabourLog[];
  createdDate: string;
  status: "ACTIVE" | "ON_HOLD" | "COMPLETED" | "CANCELLED";
};

export const rdProjects: RDProject[] = [];

// ============================================================
// PRICING CONFIG – Special Orders
// All surcharges in sen (1 RM = 100 sen)
//
// Constants live in @/lib/pricing-options so pages can import them
// without pulling in the full mock-data seed bundle. Re-exported here
// for back-compat with old imports.
// ============================================================
export type {
  DivanHeightOption,
  SpecialOrderOption,
  LegHeightOption,
} from "@/lib/pricing-options";
export {
  divanHeightOptions,
  specialOrderOptions,
  legHeightOptions,
  gapHeightOptions,
} from "@/lib/pricing-options";

// ─── Customer Hub (Parent + Branch architecture) ────────────────────
export type CustomerHub = {
  id: string;
  parentId: string | null; // null = is a parent or standalone
  creditorCode: string; // AutoCount format: 300-XXXX
  name: string;
  shortName: string; // e.g., "Houzs KL"
  state: string; // KL, PG, SRW, SBH
  pic: string;
  picContact: string;
  picEmail: string;
  deliveryAddress: string;
  isParent: boolean;
  children?: string[]; // IDs of child branches
};

export const customerHubs: CustomerHub[] = [
  // HOUZS Parent
  { id: "hub-houzs", parentId: null, creditorCode: "300-H000", name: "HOUZS CENTURY SDN BHD", shortName: "HOUZS (Parent)", state: "", pic: "Management", picContact: "011-6151 1613", picEmail: "operation@houzscentury.com", deliveryAddress: "", isParent: true, children: ["hub-houzs-kl", "hub-houzs-pg", "hub-houzs-srw", "hub-houzs-sbh"] },
  // HOUZS KL
  { id: "hub-houzs-kl", parentId: "hub-houzs", creditorCode: "300-H001", name: "Houzs KL", shortName: "Houzs KL", state: "KL", pic: "Purchasing", picContact: "011-6151 1613", picEmail: "operation@houzscentury.com", deliveryAddress: "1831-B, JALAN KPB 1, KAWASAN PERINDUSTRIAN BALAKONG, SERI KEMBANGAN, SELANGOR.", isParent: false },
  // HOUZS PG
  { id: "hub-houzs-pg", parentId: "hub-houzs", creditorCode: "300-H002", name: "Houzs PG", shortName: "Houzs PG", state: "PG", pic: "Purchasing", picContact: "011-6151 1613", picEmail: "operation@houzscentury.com", deliveryAddress: "868, JALAN ESTATE, BARU, MUKIM 12, 14100 SIMPANG AMPAT, PULAU PINANG.", isParent: false },
  // HOUZS SRW
  { id: "hub-houzs-srw", parentId: "hub-houzs", creditorCode: "300-H003", name: "Houzs SRW", shortName: "Houzs SRW", state: "SRW", pic: "Purchasing", picContact: "011-6151 1613", picEmail: "operation@houzscentury.com", deliveryAddress: "LOT 1, JALAN KOTA SAMARAHAN, SARAWAK.", isParent: false },
  // HOUZS SBH
  { id: "hub-houzs-sbh", parentId: "hub-houzs", creditorCode: "300-H004", name: "Houzs SBH", shortName: "Houzs SBH", state: "SBH", pic: "Purchasing", picContact: "011-6151 1613", picEmail: "operation@houzscentury.com", deliveryAddress: "LOT 5, JALAN KOLOMBONG, KOTA KINABALU, SABAH.", isParent: false },
  // Carress
  { id: "hub-carress", parentId: null, creditorCode: "300-C001", name: "Carress Furniture", shortName: "Carress", state: "KL", pic: "Operations", picContact: "012-3456789", picEmail: "ops@carress.com", deliveryAddress: "NO 15, JALAN USAHAWAN 1, SETAPAK, KL.", isParent: false },
  // The Conts
  { id: "hub-conts", parentId: null, creditorCode: "300-T001", name: "The Conts Trading", shortName: "The Conts", state: "JB", pic: "Purchasing", picContact: "017-9876543", picEmail: "buy@theconts.com", deliveryAddress: "LOT 88, JALAN TAMPOI, JOHOR BAHRU.", isParent: false },
];

// ============================================================
// PRODUCT DEPARTMENT CONFIGS (matching Google Sheet "SKU" tab)
// Enhanced lookup with per-department category + estimated minutes,
// plus sub-assembly definitions.
// ============================================================

export type ProductDeptConfig = {
  productCode: string;
  unitM3: number;
  fabricUsage: number; // meters
  price2Sen: number; // secondary price (sen)
  fabCutCategory: string;
  fabCutMinutes: number;
  fabSewCategory: string;
  fabSewMinutes: number;
  foamCategory: string;
  foamMinutes: number;
  framingCategory: string;
  framingMinutes: number;
  upholsteryCategory: string;
  upholsteryMinutes: number;
  packingCategory: string;
  packingMinutes: number;
  subAssemblies: { code: string; name: string; quantity: number }[];
  heightsSubAssemblies: { code: string; name: string; quantity: number }[];
};

export const productDeptConfigs: ProductDeptConfig[] = [
  // --- BEDFRAMES ---
  {
    productCode: "1009(A)",
    unitM3: 0.85,
    fabricUsage: 12,
    price2Sen: 195000,
    fabCutCategory: "CAT 3",
    fabCutMinutes: 35,
    fabSewCategory: "CAT 2",
    fabSewMinutes: 120,
    foamCategory: "CAT 2",
    foamMinutes: 20,
    framingCategory: "CAT 3",
    framingMinutes: 35,
    upholsteryCategory: "CAT 3",
    upholsteryMinutes: 35,
    packingCategory: "CAT 2",
    packingMinutes: 15,
    subAssemblies: [
      { code: "DV-STD-K", name: "Divan Heights6FT", quantity: 2 },
    ],
    heightsSubAssemblies: [
      { code: "1009(A)-H", name: "1009(A) heights", quantity: 1 },
    ],
  },
  {
    productCode: "1003(A)",
    unitM3: 0.953,
    fabricUsage: 4,
    price2Sen: 230000,
    fabCutCategory: "CAT 4",
    fabCutMinutes: 40,
    fabSewCategory: "CAT 2",
    fabSewMinutes: 150,
    foamCategory: "CAT 3",
    foamMinutes: 25,
    framingCategory: "CAT 4",
    framingMinutes: 40,
    upholsteryCategory: "CAT 4",
    upholsteryMinutes: 40,
    packingCategory: "CAT 2",
    packingMinutes: 15,
    subAssemblies: [
      { code: "DV-STD-K", name: "Divan Heights6FT", quantity: 2 },
    ],
    heightsSubAssemblies: [
      { code: "1003(A)-H", name: "1003(A) heights", quantity: 1 },
    ],
  },
  {
    productCode: "1013",
    unitM3: 0.80,
    fabricUsage: 11,
    price2Sen: 205000,
    fabCutCategory: "CAT 3",
    fabCutMinutes: 30,
    fabSewCategory: "CAT 2",
    fabSewMinutes: 110,
    foamCategory: "CAT 2",
    foamMinutes: 20,
    framingCategory: "CAT 3",
    framingMinutes: 35,
    upholsteryCategory: "CAT 3",
    upholsteryMinutes: 30,
    packingCategory: "CAT 2",
    packingMinutes: 15,
    subAssemblies: [
      { code: "DV-STD-K", name: "Divan Heights6FT", quantity: 2 },
    ],
    heightsSubAssemblies: [
      { code: "1013-H", name: "1013 heights", quantity: 1 },
    ],
  },
  {
    productCode: "2038(A)",
    unitM3: 1.05,
    fabricUsage: 16,
    price2Sen: 340000,
    fabCutCategory: "CAT 5",
    fabCutMinutes: 50,
    fabSewCategory: "CAT 3",
    fabSewMinutes: 180,
    foamCategory: "CAT 3",
    foamMinutes: 30,
    framingCategory: "CAT 5",
    framingMinutes: 50,
    upholsteryCategory: "CAT 5",
    upholsteryMinutes: 55,
    packingCategory: "CAT 3",
    packingMinutes: 20,
    subAssemblies: [
      { code: "DV-STD-K", name: "Divan Heights6FT", quantity: 2 },
    ],
    heightsSubAssemblies: [
      { code: "2038(A)-H", name: "2038(A) heights", quantity: 1 },
    ],
  },
  // --- SOFAS ---
  {
    productCode: "5535-2A",
    unitM3: 1.80,
    fabricUsage: 22,
    price2Sen: 330000,
    fabCutCategory: "CAT 4",
    fabCutMinutes: 55,
    fabSewCategory: "CAT 3",
    fabSewMinutes: 160,
    foamCategory: "CAT 3",
    foamMinutes: 35,
    framingCategory: "CAT 4",
    framingMinutes: 45,
    upholsteryCategory: "CAT 5",
    upholsteryMinutes: 60,
    packingCategory: "CAT 3",
    packingMinutes: 25,
    subAssemblies: [
      { code: "5535-ARM-L", name: "Left Arm Module", quantity: 1 },
      { code: "5535-ARM-R", name: "Right Arm Module", quantity: 1 },
    ],
    heightsSubAssemblies: [],
  },
  {
    productCode: "5535-1NA",
    unitM3: 1.40,
    fabricUsage: 16,
    price2Sen: 260000,
    fabCutCategory: "CAT 3",
    fabCutMinutes: 45,
    fabSewCategory: "CAT 2",
    fabSewMinutes: 130,
    foamCategory: "CAT 2",
    foamMinutes: 28,
    framingCategory: "CAT 3",
    framingMinutes: 38,
    upholsteryCategory: "CAT 4",
    upholsteryMinutes: 50,
    packingCategory: "CAT 2",
    packingMinutes: 20,
    subAssemblies: [
      { code: "5535-ARM-L", name: "Left Arm Module", quantity: 1 },
      { code: "5535-ARM-R", name: "Right Arm Module", quantity: 1 },
    ],
    heightsSubAssemblies: [],
  },
  {
    productCode: "5535-CNR",
    unitM3: 1.20,
    fabricUsage: 14,
    price2Sen: 195000,
    fabCutCategory: "CAT 3",
    fabCutMinutes: 40,
    fabSewCategory: "CAT 2",
    fabSewMinutes: 110,
    foamCategory: "CAT 2",
    foamMinutes: 22,
    framingCategory: "CAT 3",
    framingMinutes: 32,
    upholsteryCategory: "CAT 3",
    upholsteryMinutes: 42,
    packingCategory: "CAT 2",
    packingMinutes: 18,
    subAssemblies: [],
    heightsSubAssemblies: [],
  },
  // --- DIVAN ---
  {
    productCode: "DV-STD",
    unitM3: 0.45,
    fabricUsage: 6,
    price2Sen: 60000,
    fabCutCategory: "CAT 1",
    fabCutMinutes: 15,
    fabSewCategory: "CAT 1",
    fabSewMinutes: 20,
    foamCategory: "CAT 1",
    foamMinutes: 12,
    framingCategory: "CAT 2",
    framingMinutes: 25,
    upholsteryCategory: "CAT 2",
    upholsteryMinutes: 30,
    packingCategory: "CAT 1",
    packingMinutes: 12,
    subAssemblies: [],
    heightsSubAssemblies: [],
  },
];

// ─── Lorry / Fleet Management ─────────────────────────────────────
export type LorryInfo = {
  id: string;
  name: string; // "Lorry 1", "Lorry 2"
  plateNumber: string;
  capacity: number; // M3 capacity
  driverName: string;
  driverContact: string;
  status: "AVAILABLE" | "IN_USE" | "MAINTENANCE";
};

export const lorries: LorryInfo[] = [];

// ─── 3PL Providers ─────────────────────────────────────────────────
export type ThreePLProvider = {
  id: string;
  name: string;
  phone: string;
  contactPerson: string;
  vehicleNo: string;
  vehicleType: string;
  capacityM3: number;
  ratePerTripSen: number;
  ratePerExtraDropSen: number;
  status: "ACTIVE" | "INACTIVE" | "ON_LEAVE";
  remarks: string;
  createdAt: string;
  updatedAt: string;
};

export const threePLProviders: ThreePLProvider[] = [
  { id: "3pl-1", name: "Express Logistics Sdn Bhd", phone: "03-12345678", contactPerson: "Mr Lee", vehicleNo: "BDR 1234", vehicleType: "3-ton", capacityM3: 18, ratePerTripSen: 30000, ratePerExtraDropSen: 5000, status: "ACTIVE", remarks: "", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" },
  { id: "3pl-2", name: "FastTrack Delivery", phone: "03-87654321", contactPerson: "Mr Tan", vehicleNo: "JHR 5678", vehicleType: "5-ton", capacityM3: 30, ratePerTripSen: 45000, ratePerExtraDropSen: 8000, status: "ACTIVE", remarks: "", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" },
  { id: "3pl-3", name: "KL Transport Services", phone: "03-55556666", contactPerson: "Mr Ahmad", vehicleNo: "WKL 9012", vehicleType: "1-ton", capacityM3: 8, ratePerTripSen: 15000, ratePerExtraDropSen: 3000, status: "ACTIVE", remarks: "", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" },
];

// ─── Drivers alias (backward compat) ──────────────────────────────
export const drivers = threePLProviders;

// ─── Proof of Delivery ────────────────────────────────────────────
export type ProofOfDelivery = {
  receiverName: string;
  receiverIC: string;
  signatureDataUrl: string;
  photoDataUrls: string[];
  remarks: string;
  deliveredAt: string;
  capturedBy: string;
};

// ─── Enhanced Fabric Tracking (matches Google Sheet "Fabric" tab) ────
export type FabricTracking = {
  id: string;
  fabricCode: string;
  fabricDescription: string;
  fabricCategory: "B.M-FABR" | "S-FABR" | "S.M-FABR" | "LINING" | "WEBBING";
  priceTier: "PRICE_1" | "PRICE_2";
  price: number; // sen per meter
  soh: number; // Stock on Hand (meters)
  poOutstanding: number; // meters on order
  lastMonthUsage: number; // meters
  oneWeekUsage: number;
  twoWeeksUsage: number;
  oneMonthUsage: number;
  shortage: number; // negative = shortage
  reorderPoint: number;
  supplier: string;
  leadTimeDays: number;
};

export const fabricTrackings: FabricTracking[] = [
  { id: "ft-01", fabricCode: "AVANI 01", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-02", fabricCode: "AVANI 02", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-03", fabricCode: "AVANI 03", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-04", fabricCode: "AVANI 04", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-05", fabricCode: "AVANI 05", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-06", fabricCode: "AVANI 06", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-07", fabricCode: "AVANI 07", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-08", fabricCode: "AVANI 08", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-09", fabricCode: "AVANI 09", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-10", fabricCode: "AVANI 10", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-11", fabricCode: "AVANI 11", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-12", fabricCode: "AVANI 12", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-13", fabricCode: "AVANI 13", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-14", fabricCode: "AVANI 14", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-15", fabricCode: "AVANI 15", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-16", fabricCode: "AVANI 16", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-17", fabricCode: "AVANI 17", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-18", fabricCode: "AVANI 18", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-19", fabricCode: "BN125-4", fabricDescription: "FOSSIL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-20", fabricCode: "BO315-22", fabricDescription: "FEATHER", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-21", fabricCode: "BO315-1", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-22", fabricCode: "BO315-21", fabricDescription: "PEARL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-23", fabricCode: "BO315-23", fabricDescription: "BEIGE", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-24", fabricCode: "BO315-25", fabricDescription: "FOSSIL", fabricCategory: "S-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-25", fabricCode: "BO315-3", fabricDescription: "BEIGE", fabricCategory: "S-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-26", fabricCode: "BO315-32", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-27", fabricCode: "BO315-4", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-28", fabricCode: "BO315-11", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-29", fabricCode: "BO315-2", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-30", fabricCode: "BO315-12", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-31", fabricCode: "BO315-24", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-32", fabricCode: "BO315-5", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-33", fabricCode: "ORION-1", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-34", fabricCode: "CH141-1", fabricDescription: "CREAM", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-35", fabricCode: "CH141-11", fabricDescription: "SILVER", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-36", fabricCode: "CH141-3", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-37", fabricCode: "CH141-8", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-38", fabricCode: "CH141-14", fabricDescription: "CHARCOAL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-39", fabricCode: "GARFIELD-2 CHERVRON", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-40", fabricCode: "CH141-5", fabricDescription: "PEARL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-41", fabricCode: "CASSNYE 07", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-42", fabricCode: "CH141-2", fabricDescription: "BEIGE", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-43", fabricCode: "HR923-1", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-44", fabricCode: "GD8371-02", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-45", fabricCode: "AH-1", fabricDescription: "IVORY", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-46", fabricCode: "BO315-31", fabricDescription: "METAL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-47", fabricCode: "BO315-7", fabricDescription: "PEACH", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-48", fabricCode: "FG66151-02", fabricDescription: "PICCO FG66151-02 (FABRIC)", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-49", fabricCode: "FG66151-10", fabricDescription: "PICCO FG66151-10 (FABRIC)", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-50", fabricCode: "FG66151-15", fabricDescription: "PICCO FG66151-15 (FABRIC)", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-51", fabricCode: "FG6876-01", fabricDescription: "FG6876-01 (FABRIC)", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-52", fabricCode: "KN390-1", fabricDescription: "SOFA FABRIC KOONA VELVET PEARL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 10, twoWeeksUsage: 10, oneMonthUsage: 10, shortage: -10, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-53", fabricCode: "KN390-13", fabricDescription: "SOFA FABRIC KOONA VELVET SILVER", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-54", fabricCode: "KN390-14", fabricDescription: "SOFA FABRIC KOONA METAL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-55", fabricCode: "KN390-15", fabricDescription: "SOFA FABRIC KOONA DEEP GREY", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-56", fabricCode: "KN390-2", fabricDescription: "SOFA FABRIC KOONA VELVET SAND", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 2, twoWeeksUsage: 2, oneMonthUsage: 9, shortage: -9, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-57", fabricCode: "KN390-3", fabricDescription: "SOFA FABRIC KOONA VELVET FOSSIL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-58", fabricCode: "KN390-5", fabricDescription: "SOFA FABRIC KOONA VELVET TAN", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-59", fabricCode: "AM275-1", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-60", fabricCode: "AM275-2", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-61", fabricCode: "ZL-3", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-62", fabricCode: "KS-01 BABY WHITE", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-63", fabricCode: "KS-02 BUTTER CREAM", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-64", fabricCode: "KS-03 YELLOW PEPPER", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-65", fabricCode: "KS-04 LEATHER TAN", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-66", fabricCode: "KS-05 MID COFFEE", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-67", fabricCode: "KS-06 TUMERIC BROWN", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-68", fabricCode: "KS-07 WONDER GRAY", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-69", fabricCode: "KS-08 SEA PINK", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-70", fabricCode: "KS-09 ROMANCE ROSE", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-71", fabricCode: "KS-10 SOFT LAVENDAR", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-72", fabricCode: "KS-11 MAXI PURPLE", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-73", fabricCode: "KS-12 CLASSIC DENIM", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-74", fabricCode: "KS-13 TENDER TURQOISE", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-75", fabricCode: "KS-14 RICH JADE", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-76", fabricCode: "KS-15 COOL SILVER", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 4, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: -4, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-77", fabricCode: "KS-16 ICE STEEL", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-78", fabricCode: "KS-17 ROCK GRANITE", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-79", fabricCode: "KS-18 GRAPHITE STONE", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-80", fabricCode: "KS-19 MORNING DAWN", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-81", fabricCode: "M2402-1", fabricDescription: "PEARL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-82", fabricCode: "M2402-13", fabricDescription: "FOREST", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-83", fabricCode: "M2402-17", fabricDescription: "SILVER", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-84", fabricCode: "M2402-18", fabricDescription: "LIGHT GREY", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-85", fabricCode: "M2402-4", fabricDescription: "SAND", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-86", fabricCode: "M2402-5", fabricDescription: "LIGHT BROWN", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-87", fabricCode: "M2402-6", fabricDescription: "FOSSIL", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-88", fabricCode: "M2402-7", fabricDescription: "DARK BROWN", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-89", fabricCode: "NINJA 01", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-90", fabricCode: "NINJA 02", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-91", fabricCode: "NINJA 03", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-92", fabricCode: "NINJA 08", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-93", fabricCode: "NV-1WP", fabricDescription: "BEIGE", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-94", fabricCode: "ORION-5", fabricDescription: "ORION-5", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-95", fabricCode: "PC151-01", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 10, lastMonthUsage: 226, oneWeekUsage: 6, twoWeeksUsage: 44.5, oneMonthUsage: 57, shortage: -276, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-96", fabricCode: "PC151-02", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 54.5, oneWeekUsage: 10, twoWeeksUsage: 14, oneMonthUsage: 14, shortage: -68.5, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-97", fabricCode: "PC151-03", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 4, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: -4, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-98", fabricCode: "PC151-04", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-99", fabricCode: "PC151-05", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-100", fabricCode: "PC151-06", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-101", fabricCode: "PC151-07", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-102", fabricCode: "PC151-08", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 4, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: -4, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-103", fabricCode: "PC151-09", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 5, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: -5, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-104", fabricCode: "PC151-10", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 10, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: -10, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-105", fabricCode: "PC151-11", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 2, oneWeekUsage: 0, twoWeeksUsage: 2, oneMonthUsage: 2, shortage: -4, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-106", fabricCode: "PC151-12", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 2, oneMonthUsage: 2, shortage: -2, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-107", fabricCode: "PC151-13", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 8, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: -8, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-108", fabricCode: "PC151-14", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 16, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: -16, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-109", fabricCode: "PC151-15", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 6, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: -6, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-110", fabricCode: "PC151-16", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-111", fabricCode: "PC151-17", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 8, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 12, shortage: -26, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-112", fabricCode: "PC151-18", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 18, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: -24, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-113", fabricCode: "HR805-10", fabricDescription: "FABRIC", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-114", fabricCode: "PESTO-PT004", fabricDescription: "PESTO - OLIVE PT004-3", fabricCategory: "S.M-FABR", priceTier: "PRICE_2", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-115", fabricCode: "STAR 01", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_1", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-116", fabricCode: "STAR 02", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_1", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-117", fabricCode: "STAR 05", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_1", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-118", fabricCode: "STAR 07", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_1", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-119", fabricCode: "STAR 08", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_1", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-120", fabricCode: "STAR 11", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_1", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-121", fabricCode: "STAR 12", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_1", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
  { id: "ft-122", fabricCode: "SF-AT-15", fabricDescription: "FABRIC", fabricCategory: "B.M-FABR", priceTier: "PRICE_1", price: 0, soh: 0, poOutstanding: 0, lastMonthUsage: 0, oneWeekUsage: 0, twoWeeksUsage: 0, oneMonthUsage: 0, shortage: 0, reorderPoint: 0, supplier: "", leadTimeDays: 0 },
];

// ─── P&L Multi-Dimensional Data ────────────────────────────────────

export type PLEntry = {
  id: string;
  period: string; // "YYYY-MM"
  accountCode: string;
  accountName: string;
  category: "REVENUE" | "COGS" | "OPERATING_EXPENSE" | "OTHER_INCOME" | "OTHER_EXPENSE";
  amount: number; // sen (positive values)
  productCategory?: "BEDFRAME" | "SOFA" | "ACCESSORY" | "ALL";
  customerId?: string;
  customerName?: string;
  state?: string;
};

export type BalanceSheetEntry = {
  id: string;
  accountCode: string;
  accountName: string;
  category: "CURRENT_ASSET" | "FIXED_ASSET" | "CURRENT_LIABILITY" | "LONG_TERM_LIABILITY" | "EQUITY";
  balance: number; // sen
  asOfDate: string;
};

// --- P&L Entries: 3 months (Jan-Mar 2026) by product category & customer ---

export const plEntries: PLEntry[] = [];

// --- Balance Sheet (as of 31 March 2026) ---

export const balanceSheetEntries: BalanceSheetEntry[] = [];

// ============================================================
// GRN (Goods Receipt Notes) & 3-Way Matching
// ============================================================

export type GRNItem = {
  poItemIndex: number;
  materialCode: string;
  materialName: string;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string | null;
  unitPrice: number; // sen
};

export type GoodsReceiptNote = {
  id: string;
  grnNumber: string; // GRN-YYMM-XXX
  poId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  receiveDate: string;
  receivedBy: string;
  items: GRNItem[];
  totalAmount: number; // sen
  qcStatus: "PENDING" | "PASSED" | "PARTIAL" | "FAILED";
  status: "DRAFT" | "CONFIRMED" | "POSTED";
  notes: string;
};

export type ThreeWayMatch = {
  id: string;
  poId: string;
  poNumber: string;
  grnId: string;
  grnNumber: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  supplierId: string;
  supplierName: string;
  matchStatus: "FULL_MATCH" | "PARTIAL_MATCH" | "MISMATCH" | "PENDING_INVOICE";
  poTotal: number; // sen
  grnTotal: number; // sen
  invoiceTotal: number | null; // sen
  variance: number; // sen (absolute difference)
  variancePercent: number;
  withinTolerance: boolean; // 2% tolerance
  items: {
    materialCode: string;
    poQty: number;
    grnQty: number;
    invoiceQty: number | null;
    poPrice: number;
    grnPrice: number;
    invoicePrice: number | null;
    matched: boolean;
  }[];
};

let _grnSeq = 6;
export function getNextGRNNumber(): string {
  return `GRN-2604-${String(_grnSeq++).padStart(3, "0")}`;
}

export const grns: GoodsReceiptNote[] = [
  {
    id: "grn-1",
    grnNumber: "GRN-2604-001",
    poId: "po-1",
    poNumber: "PO-2604-016",
    supplierId: "sup-1",
    supplierName: "Kain Utama Sdn Bhd",
    receiveDate: "2026-04-09",
    receivedBy: "Ahmad bin Ismail",
    items: [
      { poItemIndex: 0, materialCode: "KU-PC151", materialName: "PC151 Dark Grey", orderedQty: 200, receivedQty: 200, acceptedQty: 200, rejectedQty: 0, rejectionReason: null, unitPrice: 2500 },
      { poItemIndex: 1, materialCode: "KU-VL100", materialName: "VL100 Taupe", orderedQty: 100, receivedQty: 100, acceptedQty: 100, rejectedQty: 0, rejectionReason: null, unitPrice: 3000 },
    ],
    totalAmount: 800000,
    qcStatus: "PASSED",
    status: "POSTED",
    notes: "Full delivery received - all QC passed",
  },
  {
    id: "grn-2",
    grnNumber: "GRN-2604-002",
    poId: "po-3",
    poNumber: "PO-2604-018",
    supplierId: "sup-3",
    supplierName: "Foam Industries M'sia Sdn Bhd",
    receiveDate: "2026-04-09",
    receivedBy: "Razlan bin Yusof",
    items: [
      { poItemIndex: 0, materialCode: "FI-HDF-25", materialName: "HD Foam 25mm", orderedQty: 40, receivedQty: 20, acceptedQty: 18, rejectedQty: 2, rejectionReason: "Density below specification", unitPrice: 3500 },
      { poItemIndex: 1, materialCode: "FI-HDF-50", materialName: "HD Foam 50mm", orderedQty: 20, receivedQty: 20, acceptedQty: 20, rejectedQty: 0, rejectionReason: null, unitPrice: 5800 },
    ],
    totalAmount: 179000,
    qcStatus: "PARTIAL",
    status: "CONFIRMED",
    notes: "Partial delivery - 2 sheets HDF-25 rejected for low density",
  },
  {
    id: "grn-3",
    grnNumber: "GRN-2604-003",
    poId: "po-2",
    poNumber: "PO-2604-017",
    supplierId: "sup-2",
    supplierName: "Papan Jaya Trading",
    receiveDate: "2026-04-13",
    receivedBy: "Ahmad bin Ismail",
    items: [
      { poItemIndex: 0, materialCode: "PJ-PLY-12", materialName: "Plywood 12mm", orderedQty: 80, receivedQty: 75, acceptedQty: 75, rejectedQty: 0, rejectionReason: null, unitPrice: 4500 },
      { poItemIndex: 1, materialCode: "PJ-WDS-25", materialName: "Wood Strip 25mm", orderedQty: 150, receivedQty: 150, acceptedQty: 148, rejectedQty: 2, rejectionReason: "Warped", unitPrice: 1800 },
    ],
    totalAmount: 603900,
    qcStatus: "PARTIAL",
    status: "CONFIRMED",
    notes: "5 plywood sheets short-delivered, 2 wood strips warped",
  },
  {
    id: "grn-4",
    grnNumber: "GRN-2604-004",
    poId: "po-1",
    poNumber: "PO-2604-016",
    supplierId: "sup-1",
    supplierName: "Kain Utama Sdn Bhd",
    receiveDate: "2026-04-11",
    receivedBy: "Razlan bin Yusof",
    items: [
      { poItemIndex: 0, materialCode: "KU-PC151", materialName: "PC151 Dark Grey", orderedQty: 200, receivedQty: 10, acceptedQty: 10, rejectedQty: 0, rejectionReason: null, unitPrice: 2500 },
    ],
    totalAmount: 25000,
    qcStatus: "PASSED",
    status: "POSTED",
    notes: "Replacement batch for minor defects found in first batch",
  },
  {
    id: "grn-5",
    grnNumber: "GRN-2604-005",
    poId: "po-3",
    poNumber: "PO-2604-018",
    supplierId: "sup-3",
    supplierName: "Foam Industries M'sia Sdn Bhd",
    receiveDate: "2026-04-14",
    receivedBy: "Ahmad bin Ismail",
    items: [
      { poItemIndex: 0, materialCode: "FI-HDF-25", materialName: "HD Foam 25mm", orderedQty: 40, receivedQty: 20, acceptedQty: 20, rejectedQty: 0, rejectionReason: null, unitPrice: 3500 },
    ],
    totalAmount: 70000,
    qcStatus: "PENDING",
    status: "DRAFT",
    notes: "Remaining 20 sheets - pending QC inspection",
  },
];

export const threeWayMatches: ThreeWayMatch[] = [
  {
    id: "twm-1",
    poId: "po-1",
    poNumber: "PO-2604-016",
    grnId: "grn-1",
    grnNumber: "GRN-2604-001",
    invoiceId: "inv-sup-001",
    invoiceNumber: "KU-INV-2604-088",
    supplierId: "sup-1",
    supplierName: "Kain Utama Sdn Bhd",
    matchStatus: "FULL_MATCH",
    poTotal: 800000,
    grnTotal: 800000,
    invoiceTotal: 800000,
    variance: 0,
    variancePercent: 0,
    withinTolerance: true,
    items: [
      { materialCode: "KU-PC151", poQty: 200, grnQty: 200, invoiceQty: 200, poPrice: 2500, grnPrice: 2500, invoicePrice: 2500, matched: true },
      { materialCode: "KU-VL100", poQty: 100, grnQty: 100, invoiceQty: 100, poPrice: 3000, grnPrice: 3000, invoicePrice: 3000, matched: true },
    ],
  },
  {
    id: "twm-2",
    poId: "po-3",
    poNumber: "PO-2604-018",
    grnId: "grn-2",
    grnNumber: "GRN-2604-002",
    invoiceId: "inv-sup-002",
    invoiceNumber: "FI-INV-2604-045",
    supplierId: "sup-3",
    supplierName: "Foam Industries M'sia Sdn Bhd",
    matchStatus: "MISMATCH",
    poTotal: 256000,
    grnTotal: 179000,
    invoiceTotal: 186000,
    variance: 70000,
    variancePercent: 27.34,
    withinTolerance: false,
    items: [
      { materialCode: "FI-HDF-25", poQty: 40, grnQty: 20, invoiceQty: 22, poPrice: 3500, grnPrice: 3500, invoicePrice: 3500, matched: false },
      { materialCode: "FI-HDF-50", poQty: 20, grnQty: 20, invoiceQty: 20, poPrice: 5800, grnPrice: 5800, invoicePrice: 5800, matched: true },
    ],
  },
  {
    id: "twm-3",
    poId: "po-2",
    poNumber: "PO-2604-017",
    grnId: "grn-3",
    grnNumber: "GRN-2604-003",
    invoiceId: null,
    invoiceNumber: null,
    supplierId: "sup-2",
    supplierName: "Papan Jaya Trading",
    matchStatus: "PENDING_INVOICE",
    poTotal: 630000,
    grnTotal: 603900,
    invoiceTotal: null,
    variance: 26100,
    variancePercent: 4.14,
    withinTolerance: false,
    items: [
      { materialCode: "PJ-PLY-12", poQty: 80, grnQty: 75, invoiceQty: null, poPrice: 4500, grnPrice: 4500, invoicePrice: null, matched: false },
      { materialCode: "PJ-WDS-25", poQty: 150, grnQty: 150, invoiceQty: null, poPrice: 1800, grnPrice: 1800, invoicePrice: null, matched: false },
    ],
  },
  {
    id: "twm-4",
    poId: "po-1",
    poNumber: "PO-2604-016",
    grnId: "grn-4",
    grnNumber: "GRN-2604-004",
    invoiceId: null,
    invoiceNumber: null,
    supplierId: "sup-1",
    supplierName: "Kain Utama Sdn Bhd",
    matchStatus: "PARTIAL_MATCH",
    poTotal: 800000,
    grnTotal: 25000,
    invoiceTotal: null,
    variance: 775000,
    variancePercent: 96.88,
    withinTolerance: false,
    items: [
      { materialCode: "KU-PC151", poQty: 200, grnQty: 10, invoiceQty: null, poPrice: 2500, grnPrice: 2500, invoicePrice: null, matched: false },
    ],
  },
];

// ============================================================
// PRICE OVERRIDE & SO STATUS CHANGE AUDIT TRAIL
// ============================================================

export type PriceOverride = {
  id: string;
  soId: string;
  soNumber: string;
  lineIndex: number;
  originalPrice: number; // sen
  overridePrice: number; // sen
  reason: string;
  approvedBy: string;
  timestamp: string;
};

export type SOStatusChange = {
  id: string;
  soId: string;
  fromStatus: string;
  toStatus: string;
  changedBy: string;
  timestamp: string;
  notes: string;
  autoActions: string[]; // e.g., ["Created PO SO-2604-001-01"]
};

export const priceOverrides: PriceOverride[] = [];
export const soStatusChanges: SOStatusChange[] = [];

// ============================================================
// CREDIT NOTES, DEBIT NOTES, PAYMENT RECORDS
// ============================================================

export type CreditNote = {
  id: string;
  noteNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  date: string;
  reason: "RETURN" | "PRICE_ADJUSTMENT" | "DAMAGE" | "OVERCHARGE" | "OTHER";
  reasonDetail: string;
  items: { description: string; quantity: number; unitPrice: number; total: number }[];
  totalAmount: number;
  status: "DRAFT" | "APPROVED" | "POSTED";
  approvedBy: string | null;
};

export type DebitNote = {
  id: string;
  noteNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  date: string;
  reason: "UNDERCHARGE" | "ADDITIONAL_CHARGE" | "PRICE_ADJUSTMENT" | "OTHER";
  reasonDetail: string;
  items: { description: string; quantity: number; unitPrice: number; total: number }[];
  totalAmount: number;
  status: "DRAFT" | "APPROVED" | "POSTED";
  approvedBy: string | null;
};

export type PaymentRecord = {
  id: string;
  receiptNumber: string;
  customerId: string;
  customerName: string;
  date: string;
  amount: number;
  method: "BANK_TRANSFER" | "CHEQUE" | "CASH" | "CREDIT_CARD";
  reference: string;
  allocations: { invoiceId: string; invoiceNumber: string; amount: number }[];
  status: "RECEIVED" | "CLEARED" | "BOUNCED";
};

let _cnSeq = 4;
export function getNextCNNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `CN-${yymm}-${String(_cnSeq++).padStart(3, "0")}`;
}

let _dnSeq = 3;
export function getNextDNNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `DN-${yymm}-${String(_dnSeq++).padStart(3, "0")}`;
}

let _recSeq = 7;
export function getNextReceiptNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `REC-${yymm}-${String(_recSeq++).padStart(3, "0")}`;
}

export const creditNotes: CreditNote[] = [
  {
    id: "cn-1",
    noteNumber: "CN-2604-001",
    invoiceId: "inv-1",
    invoiceNumber: "INV-2604-028",
    customerId: "cust-3",
    customerName: "The Conts",
    date: "2026-04-18",
    reason: "DAMAGE",
    reasonDetail: "1x Milano Bedframe King arrived with torn fabric on headboard",
    items: [{ description: "Milano Bedframe King 72x78 - Fabric damage compensation", quantity: 1, unitPrice: 320000, total: 320000 }],
    totalAmount: 320000,
    status: "POSTED",
    approvedBy: "Admin",
  },
  {
    id: "cn-2",
    noteNumber: "CN-2604-002",
    invoiceId: "inv-2",
    invoiceNumber: "INV-2604-027",
    customerId: "cust-1",
    customerName: "Houzs Century",
    date: "2026-04-14",
    reason: "OVERCHARGE",
    reasonDetail: "Incorrect pricing applied for Vienna Bedframe - should be RM2,100 not RM2,220",
    items: [{ description: "Vienna Bedframe Queen 60x78 - Price correction", quantity: 2, unitPrice: 12000, total: 24000 }],
    totalAmount: 24000,
    status: "APPROVED",
    approvedBy: "Admin",
  },
  {
    id: "cn-3",
    noteNumber: "CN-2604-003",
    invoiceId: "inv-2",
    invoiceNumber: "INV-2604-027",
    customerId: "cust-1",
    customerName: "Houzs Century",
    date: "2026-04-15",
    reason: "RETURN",
    reasonDetail: "1x Astoria Bedframe returned - customer changed order",
    items: [{ description: "Astoria Bedframe King 72x78 - Full return", quantity: 1, unitPrice: 205000, total: 205000 }],
    totalAmount: 205000,
    status: "DRAFT",
    approvedBy: null,
  },
];

export const debitNotes: DebitNote[] = [
  {
    id: "dn-1",
    noteNumber: "DN-2604-001",
    invoiceId: "inv-1",
    invoiceNumber: "INV-2604-028",
    customerId: "cust-3",
    customerName: "The Conts",
    date: "2026-04-19",
    reason: "UNDERCHARGE",
    reasonDetail: "Delivery surcharge for after-hours delivery not included in original invoice",
    items: [{ description: "After-hours delivery surcharge", quantity: 1, unitPrice: 15000, total: 15000 }],
    totalAmount: 15000,
    status: "POSTED",
    approvedBy: "Admin",
  },
  {
    id: "dn-2",
    noteNumber: "DN-2604-002",
    invoiceId: "inv-2",
    invoiceNumber: "INV-2604-027",
    customerId: "cust-1",
    customerName: "Houzs Century",
    date: "2026-04-16",
    reason: "ADDITIONAL_CHARGE",
    reasonDetail: "Additional protective wrapping requested by customer",
    items: [
      { description: "Premium protective wrapping - Astoria x2", quantity: 2, unitPrice: 5000, total: 10000 },
      { description: "Premium protective wrapping - Vienna x2", quantity: 2, unitPrice: 5000, total: 10000 },
    ],
    totalAmount: 20000,
    status: "APPROVED",
    approvedBy: "Admin",
  },
];

export const paymentRecords: PaymentRecord[] = [
  {
    id: "pmr-1",
    receiptNumber: "REC-2604-001",
    customerId: "cust-3",
    customerName: "The Conts",
    date: "2026-04-18",
    amount: 320000,
    method: "BANK_TRANSFER",
    reference: "TRF-20260418-001",
    allocations: [{ invoiceId: "inv-1", invoiceNumber: "INV-2604-028", amount: 320000 }],
    status: "CLEARED",
  },
  {
    id: "pmr-2",
    receiptNumber: "REC-2604-002",
    customerId: "cust-3",
    customerName: "The Conts",
    date: "2026-04-20",
    amount: 320000,
    method: "BANK_TRANSFER",
    reference: "TRF-20260420-002",
    allocations: [{ invoiceId: "inv-1", invoiceNumber: "INV-2604-028", amount: 320000 }],
    status: "CLEARED",
  },
  {
    id: "pmr-3",
    receiptNumber: "REC-2604-003",
    customerId: "cust-1",
    customerName: "Houzs Century",
    date: "2026-04-15",
    amount: 200000,
    method: "CHEQUE",
    reference: "CHQ-881234",
    allocations: [{ invoiceId: "inv-2", invoiceNumber: "INV-2604-027", amount: 200000 }],
    status: "RECEIVED",
  },
  {
    id: "pmr-4",
    receiptNumber: "REC-2604-004",
    customerId: "cust-1",
    customerName: "Houzs Century",
    date: "2026-04-12",
    amount: 500000,
    method: "BANK_TRANSFER",
    reference: "TRF-20260412-005",
    allocations: [],
    status: "CLEARED",
  },
  {
    id: "pmr-5",
    receiptNumber: "REC-2604-005",
    customerId: "cust-2",
    customerName: "CARRESS SDN BHD",
    date: "2026-04-10",
    amount: 1500000,
    method: "BANK_TRANSFER",
    reference: "TRF-20260410-003",
    allocations: [],
    status: "CLEARED",
  },
  {
    id: "pmr-6",
    receiptNumber: "REC-2604-006",
    customerId: "cust-1",
    customerName: "Houzs Century",
    date: "2026-04-08",
    amount: 350000,
    method: "CASH",
    reference: "CASH-20260408",
    allocations: [],
    status: "RECEIVED",
  },
];

// ============================================================
// PAYSLIP DETAILS - Malaysian Statutory Deductions & OT
// ============================================================

export type PayslipDetail = {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  departmentCode: string;
  period: string; // "YYYY-MM"
  basicSalary: number; // sen
  workingDays: number;
  otWeekdayHours: number;
  otSundayHours: number;
  otPHHours: number;
  hourlyRate: number; // sen - calculated: basicSalary / (26 * 9)
  otWeekdayAmount: number; // hourlyRate * 1.5 * hours
  otSundayAmount: number; // hourlyRate * 2.0 * hours
  otPHAmount: number; // hourlyRate * 3.0 * hours
  totalOT: number;
  allowances: number;
  grossPay: number; // basic + OT + allowances
  epfEmployee: number; // 11% of basic
  epfEmployer: number; // 13% of basic
  socsoEmployee: number;
  socsoEmployer: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number; // tax deduction
  totalDeductions: number;
  netPay: number; // gross - deductions
  bankAccount: string;
  status: "DRAFT" | "APPROVED" | "PAID";
};

// Malaysian statutory calculation helpers
export function calcHourlyRate(basicSalarySen: number): number {
  return Math.round(basicSalarySen / (26 * 9));
}

export function calcOT(hourlyRateSen: number, weekdayHrs: number, sundayHrs: number, phHrs: number) {
  const weekday = Math.round(hourlyRateSen * 1.5 * weekdayHrs);
  const sunday = Math.round(hourlyRateSen * 2.0 * sundayHrs);
  const ph = Math.round(hourlyRateSen * 3.0 * phHrs);
  return { weekday, sunday, ph, total: weekday + sunday + ph };
}

export function calcStatutory(basicSalarySen: number) {
  return {
    epfEmployee: Math.round(basicSalarySen * 0.11),
    epfEmployer: Math.round(basicSalarySen * 0.13),
    socsoEmployee: 745,   // ~RM 7.45 for salary bracket RM1800-2200
    socsoEmployer: 2615,  // ~RM 26.15
    eisEmployee: 390,     // ~RM 3.90
    eisEmployer: 390,     // ~RM 3.90
    pcb: 0,               // 0 for foreign workers at this salary range
  };
}

let _payslipIdCounter = 1;
export function getNextPayslipId(): string {
  return `PS-${String(_payslipIdCounter++).padStart(5, "0")}`;
}

function generatePayslipForWorker(
  worker: Worker,
  period: string,
  otWeekday: number,
  otSunday: number,
  otPH: number,
  allowances: number,
  status: "DRAFT" | "APPROVED" | "PAID" = "DRAFT"
): PayslipDetail {
  const hourlyRate = calcHourlyRate(worker.basicSalarySen);
  const ot = calcOT(hourlyRate, otWeekday, otSunday, otPH);
  const grossPay = worker.basicSalarySen + ot.total + allowances;
  const stat = calcStatutory(worker.basicSalarySen);
  const totalDeductions = stat.epfEmployee + stat.socsoEmployee + stat.eisEmployee + stat.pcb;
  const netPay = grossPay - totalDeductions;

  return {
    id: getNextPayslipId(),
    employeeId: worker.id,
    employeeName: worker.name,
    employeeNo: worker.empNo,
    departmentCode: worker.departmentCode,
    period,
    basicSalary: worker.basicSalarySen,
    workingDays: worker.workingDaysPerMonth,
    otWeekdayHours: otWeekday,
    otSundayHours: otSunday,
    otPHHours: otPH,
    hourlyRate,
    otWeekdayAmount: ot.weekday,
    otSundayAmount: ot.sunday,
    otPHAmount: ot.ph,
    totalOT: ot.total,
    allowances,
    grossPay,
    epfEmployee: stat.epfEmployee,
    epfEmployer: stat.epfEmployer,
    socsoEmployee: stat.socsoEmployee,
    socsoEmployer: stat.socsoEmployer,
    eisEmployee: stat.eisEmployee,
    eisEmployer: stat.eisEmployer,
    pcb: stat.pcb,
    totalDeductions,
    netPay,
    bankAccount: `CIMB-${worker.empNo.replace("EMP-", "")}XXXX`,
    status,
  };
}

// Pre-populated payslip data for March & February 2026
export const payslipDetails: PayslipDetail[] = [
  // --- March 2026 (PAID) ---
  generatePayslipForWorker(workers[0],  "2026-03", 12, 4, 0, 0, "PAID"),
  generatePayslipForWorker(workers[1],  "2026-03", 10, 0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[2],  "2026-03", 8,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[3],  "2026-03", 8,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[4],  "2026-03", 14, 4, 0, 0, "PAID"),
  generatePayslipForWorker(workers[5],  "2026-03", 6,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[6],  "2026-03", 15, 8, 0, 0, "PAID"),
  generatePayslipForWorker(workers[7],  "2026-03", 10, 4, 0, 0, "PAID"),
  generatePayslipForWorker(workers[8],  "2026-03", 10, 0, 8, 0, "PAID"),
  generatePayslipForWorker(workers[9],  "2026-03", 12, 4, 0, 0, "PAID"),
  generatePayslipForWorker(workers[10], "2026-03", 8,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[11], "2026-03", 6,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[12], "2026-03", 10, 4, 0, 0, "PAID"),
  generatePayslipForWorker(workers[13], "2026-03", 5,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[14], "2026-03", 8,  0, 0, 0, "PAID"),
  // --- February 2026 (PAID) ---
  generatePayslipForWorker(workers[0],  "2026-02", 10, 0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[1],  "2026-02", 8,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[2],  "2026-02", 6,  4, 0, 0, "PAID"),
  generatePayslipForWorker(workers[3],  "2026-02", 12, 0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[4],  "2026-02", 10, 0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[5],  "2026-02", 8,  4, 0, 0, "PAID"),
  generatePayslipForWorker(workers[6],  "2026-02", 14, 8, 8, 0, "PAID"),
  generatePayslipForWorker(workers[7],  "2026-02", 12, 0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[8],  "2026-02", 8,  4, 0, 0, "PAID"),
  generatePayslipForWorker(workers[9],  "2026-02", 10, 0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[10], "2026-02", 6,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[11], "2026-02", 8,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[12], "2026-02", 12, 4, 0, 0, "PAID"),
  generatePayslipForWorker(workers[13], "2026-02", 4,  0, 0, 0, "PAID"),
  generatePayslipForWorker(workers[14], "2026-02", 6,  0, 0, 0, "PAID"),
];

// ============================================================
// BACKWARD SCHEDULING - Department Lead Times & Schedule Entries
// ============================================================

export type DeptLeadTime = {
  deptCode: string;
  deptName: string;
  bedframeDays: number;
  sofaDays: number;
};

export type ScheduleEntry = {
  id: string;
  productionOrderId: string;
  soNumber: string;
  productCode: string;
  category: "BEDFRAME" | "SOFA";
  customerDeliveryDate: string;
  customerName: string;
  deptSchedule: {
    deptCode: string;
    deptName: string;
    startDate: string;
    endDate: string;
    minutes: number;
    status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "OVERDUE";
  }[];
  hookkaExpectedDD: string;
};

export const deptLeadTimes: DeptLeadTime[] = [];

export const scheduleEntries: ScheduleEntry[] = [];

// ============================================================
// BOM (Bill of Materials) Visual Editor - Multi-Level BOM Tree
// ============================================================

export type WIPType = "HEADBOARD" | "DIVAN" | "SOFA_BASE" | "SOFA_CUSHION" | "SOFA_ARMREST" | "SOFA_HEADREST";

export type BOMNode = {
  id: string;
  productCode: string;
  name: string;
  level: number;
  type: "FINISHED_GOOD" | "SUB_ASSEMBLY" | "MATERIAL";
  wipType?: WIPType; // WIP category when type is SUB_ASSEMBLY
  inventoryCode?: string; // link to rawMaterials itemCode
  quantity: number;
  unit: string;
  stockAccount: string;
  routing: { department: string; deptCode: string; category: string; minutes: number }[];
  children: BOMNode[];
  materials: { code: string; name: string; qty: number; unit: string; wastePct: number; costPerUnit: number; inventoryCode?: string }[];
};

export type BOMVersion = {
  id: string;
  productId: string;
  productCode: string;
  version: string;
  status: "ACTIVE" | "DRAFT" | "OBSOLETE";
  effectiveFrom: string;
  effectiveTo: string | null;
  tree: BOMNode;
  totalMinutes: number;
  labourCost: number;
  materialCost: number;
  totalCost: number;
};

const LABOUR_RATE_SEN_PER_MIN = 14.6;

export const bomVersions: BOMVersion[] = [
  {
    id: "bom-v-1", productId: "prod-2", productCode: "1003-(K)", version: "v1.0", status: "ACTIVE", effectiveFrom: "2025-01-01", effectiveTo: null,
    tree: {
      id: "bn-1", productCode: "1003-(K)", name: "HILTON BEDFRAME (6FT) 183x190CM", level: 0, type: "FINISHED_GOOD", quantity: 1, unit: "SET", stockAccount: "330-9000",
      routing: [
        { department: "Fabric Cutting", deptCode: "FAB_CUT", category: "CAT 3", minutes: 50 },
        { department: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 2", minutes: 150 },
        { department: "Foam Bonding", deptCode: "FOAM", category: "CAT 3", minutes: 25 },
      ],
      materials: [{ code: "FAB-BM-001", name: "BM Fabric (PC151)", qty: 4, unit: "METER", wastePct: 5, costPerUnit: 2500, inventoryCode: "AVANI 01" }],
      children: [
        {
          id: "bn-2", productCode: "WIP-DV6", name: "Divan 6FT", level: 1, type: "SUB_ASSEMBLY", wipType: "DIVAN", quantity: 2, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 6", minutes: 15 },
            { department: "Packing", deptCode: "PACKING", category: "CAT 3", minutes: 20 },
          ],
          materials: [],
          children: [
            {
              id: "bn-2a", productCode: "WIP-DV6-FRAME", name: "Divan Frame 6FT", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 20 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 6", minutes: 20 },
              ],
              materials: [
                { code: "PLY-18", name: "18mm Plywood", qty: 1, unit: "SHEET", wastePct: 8, costPerUnit: 4500, inventoryCode: "18MM 4' X 8'" },
                { code: "WD-STRIP", name: "Wood Strip 2x4", qty: 4, unit: "PCS", wastePct: 3, costPerUnit: 800 },
                { code: "SCR-WD", name: "Wood Screws", qty: 1, unit: "BOX", wastePct: 0, costPerUnit: 350 },
              ],
              children: [],
            },
            {
              id: "bn-2b", productCode: "WIP-DV6-WEB", name: "Divan Webbing 6FT", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Webbing", deptCode: "WEBBING", category: "CAT 1", minutes: 20 },
              ],
              materials: [
                { code: "WEB-EL", name: "Elastic Webbing", qty: 1, unit: "ROLL", wastePct: 5, costPerUnit: 1200 },
              ],
              children: [],
            },
          ],
        },
        {
          id: "bn-3", productCode: "WIP-HB-1003K", name: "Headboard 1003-(K)", level: 1, type: "SUB_ASSEMBLY", wipType: "HEADBOARD", quantity: 1, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 4", minutes: 40 },
            { department: "Packing", deptCode: "PACKING", category: "CAT 2", minutes: 30 },
          ],
          materials: [],
          children: [
            {
              id: "bn-3a", productCode: "WIP-HB-1003K-FRAME", name: "HB Frame 1003-(K)", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 5", minutes: 10 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 4", minutes: 40 },
              ],
              materials: [
                { code: "PLY-18", name: "18mm Plywood", qty: 1, unit: "SHEET", wastePct: 8, costPerUnit: 4500, inventoryCode: "18MM 4' X 8'" },
                { code: "WD-STRIP", name: "Wood Strip 2x4", qty: 3, unit: "PCS", wastePct: 3, costPerUnit: 800 },
              ],
              children: [],
            },
            {
              id: "bn-3b", productCode: "WIP-HB-1003K-PAD", name: "HB Foam Padding", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Webbing", deptCode: "WEBBING", category: "CAT 3", minutes: 20 },
              ],
              materials: [
                { code: "FOAM-HD", name: "High Density Foam", qty: 1, unit: "SHEET", wastePct: 10, costPerUnit: 3500 },
                { code: "WEB-EL", name: "Elastic Webbing", qty: 0.5, unit: "ROLL", wastePct: 5, costPerUnit: 1200 },
              ],
              children: [],
            },
          ],
        },
      ],
    },
    totalMinutes: 555, labourCost: Math.round(555 * LABOUR_RATE_SEN_PER_MIN), materialCost: 3985000, totalCost: Math.round(555 * LABOUR_RATE_SEN_PER_MIN) + 3985000,
  },
  {
    id: "bom-v-2", productId: "prod-2", productCode: "1003-(Q)", version: "v1.0", status: "ACTIVE", effectiveFrom: "2025-01-01", effectiveTo: null,
    tree: {
      id: "bn-4", productCode: "1003-(Q)", name: "HILTON BEDFRAME (5FT) 152x190CM", level: 0, type: "FINISHED_GOOD", quantity: 1, unit: "SET", stockAccount: "330-9000",
      routing: [
        { department: "Fabric Cutting", deptCode: "FAB_CUT", category: "CAT 3", minutes: 40 },
        { department: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 2", minutes: 120 },
        { department: "Foam Bonding", deptCode: "FOAM", category: "CAT 3", minutes: 20 },
      ],
      materials: [{ code: "FAB-BM-001", name: "BM Fabric (PC151)", qty: 3.5, unit: "METER", wastePct: 5, costPerUnit: 2500, inventoryCode: "AVANI 01" }],
      children: [
        {
          id: "bn-5", productCode: "WIP-DV5", name: "Divan 5FT", level: 1, type: "SUB_ASSEMBLY", wipType: "DIVAN", quantity: 2, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 5", minutes: 12 },
            { department: "Packing", deptCode: "PACKING", category: "CAT 3", minutes: 18 },
          ],
          materials: [],
          children: [
            {
              id: "bn-5a", productCode: "WIP-DV5-FRAME", name: "Divan Frame 5FT", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 18 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 5", minutes: 18 },
              ],
              materials: [
                { code: "PLY-18", name: "18mm Plywood", qty: 1, unit: "SHEET", wastePct: 8, costPerUnit: 4500, inventoryCode: "18MM 4' X 8'" },
                { code: "WD-STRIP", name: "Wood Strip 2x4", qty: 3, unit: "PCS", wastePct: 3, costPerUnit: 800 },
              ],
              children: [],
            },
            {
              id: "bn-5b", productCode: "WIP-DV5-WEB", name: "Divan Webbing 5FT", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Webbing", deptCode: "WEBBING", category: "CAT 1", minutes: 18 },
              ],
              materials: [
                { code: "WEB-EL", name: "Elastic Webbing", qty: 1, unit: "ROLL", wastePct: 5, costPerUnit: 1200 },
              ],
              children: [],
            },
          ],
        },
        {
          id: "bn-6", productCode: "WIP-HB-1003Q", name: "Headboard 1003-(Q)", level: 1, type: "SUB_ASSEMBLY", wipType: "HEADBOARD", quantity: 1, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 3", minutes: 35 },
            { department: "Packing", deptCode: "PACKING", category: "CAT 2", minutes: 25 },
          ],
          materials: [],
          children: [
            {
              id: "bn-6a", productCode: "WIP-HB-1003Q-FRAME", name: "HB Frame 1003-(Q)", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 4", minutes: 10 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 3", minutes: 35 },
              ],
              materials: [
                { code: "PLY-18", name: "18mm Plywood", qty: 1, unit: "SHEET", wastePct: 8, costPerUnit: 4500, inventoryCode: "18MM 4' X 8'" },
                { code: "WD-STRIP", name: "Wood Strip 2x4", qty: 2, unit: "PCS", wastePct: 3, costPerUnit: 800 },
              ],
              children: [],
            },
            {
              id: "bn-6b", productCode: "WIP-HB-1003Q-PAD", name: "HB Foam Padding", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Webbing", deptCode: "WEBBING", category: "CAT 3", minutes: 18 },
              ],
              materials: [
                { code: "FOAM-HD", name: "High Density Foam", qty: 1, unit: "SHEET", wastePct: 10, costPerUnit: 3500 },
              ],
              children: [],
            },
          ],
        },
      ],
    },
    totalMinutes: 471, labourCost: Math.round(471 * LABOUR_RATE_SEN_PER_MIN), materialCost: 3250000, totalCost: Math.round(471 * LABOUR_RATE_SEN_PER_MIN) + 3250000,
  },
  {
    id: "bom-v-3", productId: "prod-5", productCode: "5530-1A", version: "v1.0", status: "ACTIVE", effectiveFrom: "2025-03-01", effectiveTo: null,
    tree: {
      id: "bn-7", productCode: "5530-1A", name: "5530-1A(LHF) SOFA", level: 0, type: "FINISHED_GOOD", quantity: 1, unit: "SET", stockAccount: "330-9000",
      routing: [
        { department: "Fabric Cutting", deptCode: "FAB_CUT", category: "CAT 4", minutes: 70 },
        { department: "Packing", deptCode: "PACKING", category: "CAT 1", minutes: 40 },
        { department: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 5", minutes: 40 },
      ],
      materials: [{ code: "FAB-SM-001", name: "SM Fabric (KN390)", qty: 7, unit: "METER", wastePct: 8, costPerUnit: 3200, inventoryCode: "AM275-1" }],
      children: [
        {
          id: "bn-8", productCode: "WIP-BASE-5530", name: "Sofa Base", level: 1, type: "SUB_ASSEMBLY", wipType: "SOFA_BASE", quantity: 1, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 3", minutes: 150 },
            { department: "Webbing", deptCode: "WEBBING", category: "CAT 2", minutes: 20 },
          ],
          materials: [],
          children: [
            {
              id: "bn-8a", productCode: "WIP-BASE-5530-FRAME", name: "Base Frame", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 2", minutes: 30 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 3", minutes: 40 },
              ],
              materials: [
                { code: "PLY-18", name: "18mm Plywood", qty: 2, unit: "SHEET", wastePct: 8, costPerUnit: 4500, inventoryCode: "18MM 4' X 8'" },
                { code: "WD-STRIP", name: "Wood Strip 2x4", qty: 6, unit: "PCS", wastePct: 3, costPerUnit: 800 },
                { code: "WEB-SF", name: "Sofa Webbing Strip", qty: 1, unit: "ROLL", wastePct: 5, costPerUnit: 1500 },
              ],
              children: [],
            },
            {
              id: "bn-8b", productCode: "WIP-BASE-5530-FOAM", name: "Base Foam Pad", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Foam Bonding", deptCode: "FOAM", category: "CAT 2", minutes: 30 },
              ],
              materials: [
                { code: "FOAM-SC", name: "Sofa Cushion Foam", qty: 2, unit: "SHEET", wastePct: 12, costPerUnit: 5200 },
              ],
              children: [],
            },
          ],
        },
        {
          id: "bn-9", productCode: "WIP-CUSH-5530", name: "Sofa Cushion", level: 1, type: "SUB_ASSEMBLY", wipType: "SOFA_CUSHION", quantity: 1, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 2", minutes: 40 },
          ],
          materials: [],
          children: [
            {
              id: "bn-9a", productCode: "WIP-CUSH-5530-FRAME", name: "Cushion Frame", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 15 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 2", minutes: 15 },
                { department: "Webbing", deptCode: "WEBBING", category: "CAT 1", minutes: 15 },
              ],
              materials: [
                { code: "WD-STRIP", name: "Wood Strip 2x4", qty: 2, unit: "PCS", wastePct: 3, costPerUnit: 800 },
              ],
              children: [],
            },
            {
              id: "bn-9b", productCode: "WIP-CUSH-5530-FOAM", name: "Cushion Foam", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Foam Bonding", deptCode: "FOAM", category: "CAT 1", minutes: 15 },
              ],
              materials: [
                { code: "FOAM-SC", name: "Sofa Cushion Foam", qty: 1, unit: "SHEET", wastePct: 12, costPerUnit: 5200 },
              ],
              children: [],
            },
          ],
        },
        {
          id: "bn-10", productCode: "WIP-LARM-5530", name: "Left Armrest", level: 1, type: "SUB_ASSEMBLY", wipType: "SOFA_ARMREST", quantity: 1, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 2", minutes: 30 },
          ],
          materials: [],
          children: [
            {
              id: "bn-10a", productCode: "WIP-LARM-5530-FRAME", name: "Arm Frame", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 10 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 3", minutes: 30 },
                { department: "Webbing", deptCode: "WEBBING", category: "CAT 1", minutes: 15 },
              ],
              materials: [
                { code: "PLY-18", name: "18mm Plywood", qty: 0.5, unit: "SHEET", wastePct: 8, costPerUnit: 4500, inventoryCode: "18MM 4' X 8'" },
                { code: "WD-STRIP", name: "Wood Strip 2x4", qty: 2, unit: "PCS", wastePct: 3, costPerUnit: 800 },
              ],
              children: [],
            },
            {
              id: "bn-10b", productCode: "WIP-LARM-5530-FOAM", name: "Arm Foam Pad", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Foam Bonding", deptCode: "FOAM", category: "CAT 2", minutes: 30 },
              ],
              materials: [
                { code: "FOAM-SC", name: "Sofa Cushion Foam", qty: 1, unit: "SHEET", wastePct: 12, costPerUnit: 5200 },
              ],
              children: [],
            },
          ],
        },
        {
          id: "bn-15", productCode: "WIP-HDREST-5530", name: "Sofa Headrest", level: 1, type: "SUB_ASSEMBLY", wipType: "SOFA_HEADREST", quantity: 1, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 1", minutes: 20 },
            { department: "Foam Bonding", deptCode: "FOAM", category: "CAT 1", minutes: 10 },
          ],
          materials: [
            { code: "FOAM-HD", name: "High Density Foam", qty: 0.5, unit: "SHEET", wastePct: 10, costPerUnit: 3500 },
          ],
          children: [],
        },
      ],
    },
    totalMinutes: 635, labourCost: Math.round(635 * LABOUR_RATE_SEN_PER_MIN), materialCost: 5680000, totalCost: Math.round(635 * LABOUR_RATE_SEN_PER_MIN) + 5680000,
  },
  {
    id: "bom-v-4", productId: "prod-5", productCode: "5530-1A", version: "v2.0", status: "DRAFT", effectiveFrom: "2026-06-01", effectiveTo: null,
    tree: {
      id: "bn-11", productCode: "5530-1A", name: "5530-1A(LHF) SOFA (Revised)", level: 0, type: "FINISHED_GOOD", quantity: 1, unit: "SET", stockAccount: "330-9000",
      routing: [
        { department: "Fabric Cutting", deptCode: "FAB_CUT", category: "CAT 4", minutes: 65 },
        { department: "Packing", deptCode: "PACKING", category: "CAT 1", minutes: 35 },
        { department: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 5", minutes: 35 },
      ],
      materials: [{ code: "FAB-SM-002", name: "SM Fabric (Ninja)", qty: 6.5, unit: "METER", wastePct: 7, costPerUnit: 2800 }],
      children: [
        {
          id: "bn-12", productCode: "WIP-BASE-5530", name: "Sofa Base", level: 1, type: "SUB_ASSEMBLY", wipType: "SOFA_BASE", quantity: 1, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 3", minutes: 140 },
            { department: "Webbing", deptCode: "WEBBING", category: "CAT 2", minutes: 18 },
          ],
          materials: [],
          children: [
            {
              id: "bn-12a", productCode: "WIP-BASE-5530-FRAME", name: "Base Frame", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 2", minutes: 28 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 3", minutes: 38 },
              ],
              materials: [
                { code: "PLY-18", name: "18mm Plywood", qty: 2, unit: "SHEET", wastePct: 8, costPerUnit: 4500, inventoryCode: "18MM 4' X 8'" },
                { code: "WD-STRIP", name: "Wood Strip 2x4", qty: 5, unit: "PCS", wastePct: 3, costPerUnit: 800 },
              ],
              children: [],
            },
            {
              id: "bn-12b", productCode: "WIP-BASE-5530-FOAM", name: "Base Foam Pad", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Foam Bonding", deptCode: "FOAM", category: "CAT 2", minutes: 28 },
              ],
              materials: [
                { code: "FOAM-SC", name: "Sofa Cushion Foam", qty: 2, unit: "SHEET", wastePct: 12, costPerUnit: 5200 },
              ],
              children: [],
            },
          ],
        },
        {
          id: "bn-13", productCode: "WIP-CUSH-5530", name: "Sofa Cushion", level: 1, type: "SUB_ASSEMBLY", wipType: "SOFA_CUSHION", quantity: 1, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 2", minutes: 38 },
          ],
          materials: [],
          children: [
            {
              id: "bn-13a", productCode: "WIP-CUSH-5530-FRAME", name: "Cushion Frame", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 14 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 2", minutes: 14 },
                { department: "Webbing", deptCode: "WEBBING", category: "CAT 1", minutes: 14 },
              ],
              materials: [],
              children: [],
            },
            {
              id: "bn-13b", productCode: "WIP-CUSH-5530-FOAM", name: "Cushion Foam", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Foam Bonding", deptCode: "FOAM", category: "CAT 1", minutes: 14 },
              ],
              materials: [
                { code: "FOAM-SC", name: "Sofa Cushion Foam", qty: 1, unit: "SHEET", wastePct: 12, costPerUnit: 5200 },
              ],
              children: [],
            },
          ],
        },
        {
          id: "bn-14", productCode: "WIP-LARM-5530", name: "Left Armrest", level: 1, type: "SUB_ASSEMBLY", wipType: "SOFA_ARMREST", quantity: 1, unit: "PCS", stockAccount: "330-8000",
          routing: [
            { department: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 2", minutes: 28 },
          ],
          materials: [],
          children: [
            {
              id: "bn-14a", productCode: "WIP-LARM-5530-FRAME", name: "Arm Frame", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 10 },
                { department: "Framing", deptCode: "FRAMING", category: "CAT 3", minutes: 28 },
                { department: "Webbing", deptCode: "WEBBING", category: "CAT 1", minutes: 14 },
              ],
              materials: [
                { code: "PLY-18", name: "18mm Plywood", qty: 0.5, unit: "SHEET", wastePct: 8, costPerUnit: 4500, inventoryCode: "18MM 4' X 8'" },
              ],
              children: [],
            },
            {
              id: "bn-14b", productCode: "WIP-LARM-5530-FOAM", name: "Arm Foam Pad", level: 2, type: "SUB_ASSEMBLY", quantity: 1, unit: "PCS", stockAccount: "330-8100",
              routing: [
                { department: "Foam Bonding", deptCode: "FOAM", category: "CAT 2", minutes: 28 },
              ],
              materials: [
                { code: "FOAM-SC", name: "Sofa Cushion Foam", qty: 1, unit: "SHEET", wastePct: 12, costPerUnit: 5200 },
              ],
              children: [],
            },
          ],
        },
      ],
    },
    totalMinutes: 599, labourCost: Math.round(599 * LABOUR_RATE_SEN_PER_MIN), materialCost: 5120000, totalCost: Math.round(599 * LABOUR_RATE_SEN_PER_MIN) + 5120000,
  },
];

// ============================================================
// BOM Templates - defines production routing per product
// ============================================================

export type BOMTemplateProcess = {
  dept: string;
  deptCode: string;
  category: string;
  minutes: number;
};

// Code segment: either a literal word ("Divan-") or a variant placeholder
// (DIVAN_HEIGHT, SIZE, FABRIC, MODULE, PRODUCT_CODE, LEG_HEIGHT, TOTAL_HEIGHT).
// Matches the shape the BOM Module Builder writes to localStorage and now
// syncs to the server via PUT /api/bom/templates.
export type BOMCodeSegment = {
  type: "word" | "variant";
  variantCategory?: string;
  value: string;
  autoDetect?: boolean;
};

export type BOMTemplateWIP = {
  id: string;
  wipCode: string;
  // Optional code template; when present, used at SO confirm time to
  // interpolate real SO item values (divan height, size, fabric...) into
  // a human-readable WIP label like `8" Divan- 6FT`. Falls back to wipCode
  // when missing (legacy / seed templates).
  codeSegments?: BOMCodeSegment[];
  wipType: WIPType;
  quantity: number;
  processes: BOMTemplateProcess[];
  // Recursive sub-WIPs — each child is its own node with its own
  // codeSegments, processes, and further children. Matches the BOM
  // Module Builder's nested tree model.
  children?: BOMTemplateWIP[];
  // Raw materials required by this WIP component.
  // Each material links to rawMaterials via inventoryCode → itemCode.
  materials?: { code: string; name: string; qty: number; unit: string; inventoryCode?: string; autoDetect?: "FABRIC" | "LEG" }[];
  // Substitute / alternative materials for this WIP component.
  // Most commonly used for fabric substitution.
  substitutes?: MaterialSubstitute[];
};

export type BOMVersionStatus = "DRAFT" | "ACTIVE" | "OBSOLETE";

export type BOMTemplate = {
  id: string;
  productCode: string;
  baseModel: string;
  category: "BEDFRAME" | "SOFA";
  l1Processes: BOMTemplateProcess[];
  wipComponents: BOMTemplateWIP[];
  // Version control fields
  version: string;              // "1.0", "2.0", etc.
  versionStatus: BOMVersionStatus;
  effectiveFrom: string;        // ISO date
  effectiveTo?: string;         // ISO date, null/undefined = no end
  changeLog?: string;           // e.g. "Changed plywood from 12mm to 15mm"
};

// -- Bedframe BOM process constants --
// L1 (FG-level) processes intentionally empty — real BOMs have no FG layer.
// All production work lives on per-WIP routes (Divan / Headboard).
const BF_L1: BOMTemplateProcess[] = [];

// ---------------------------------------------------------------------------
// Bedframe BOM — mirrors the user's real BOM Module Builder tree for
// 1003-(K) exactly as shown in the app UI:
//
//   L2  "8" Divan- 6FT"                → Packing, Upholstery
//     L3  "8" Divan- 6FT Foam"         → Webbing
//       L4  "8" Divan- 6FT Frame"      → Framing
//         L5  "8" Divan- 6FT (WD)"     → Wood Cut
//     L3  "8" Divan- 6FT PC151-01"     → Fab Sew
//
// Each nested node carries its OWN codeSegments so the walker emits a
// card labeled with that node's resolved code into the dept its
// `processes` list points to. Same pattern applies to HB (kept flat 5
// processes for now — update when user shares HB BOM structure).
// ---------------------------------------------------------------------------

// Parent-level code segments — matches BOM Builder default.
const BF_DIVAN_PARENT_SEGS: BOMCodeSegment[] = [
  { type: "variant", variantCategory: "DIVAN_HEIGHT", value: "", autoDetect: true },
  { type: "word", value: "Divan-" },
  { type: "variant", variantCategory: "SIZE", value: "", autoDetect: true },
];
const BF_HB_PARENT_SEGS: BOMCodeSegment[] = [
  { type: "variant", variantCategory: "PRODUCT_CODE", value: "", autoDetect: true },
  { type: "word", value: "-HB" },
  { type: "variant", variantCategory: "TOTAL_HEIGHT", value: "", autoDetect: true },
];

// Helper: build Divan child segs = parent segs + literal suffix word.
function bfDivanChildSegs(suffix: string): BOMCodeSegment[] {
  return [...BF_DIVAN_PARENT_SEGS, { type: "word", value: suffix }];
}
// Helper: build Divan child segs with a {FABRIC} placeholder + optional trailing word.
function bfDivanFabricSegs(trailing?: string): BOMCodeSegment[] {
  const segs: BOMCodeSegment[] = [
    ...BF_DIVAN_PARENT_SEGS,
    { type: "variant", variantCategory: "FABRIC", value: "", autoDetect: true },
  ];
  if (trailing) segs.push({ type: "word", value: trailing });
  return segs;
}
// Helper: build HB child segs = parent segs + literal suffix word.
function bfHbChildSegs(suffix: string): BOMCodeSegment[] {
  return [...BF_HB_PARENT_SEGS, { type: "word", value: suffix }];
}
// Helper: build HB child segs with a {FABRIC} placeholder and optional words
// before/after the fabric token (e.g. `{FABRIC} Foam` or `{FABRIC} (FC)`).
function bfHbFabricSegs(trailing?: string): BOMCodeSegment[] {
  const segs: BOMCodeSegment[] = [
    ...BF_HB_PARENT_SEGS,
    { type: "variant", variantCategory: "FABRIC", value: "", autoDetect: true },
  ];
  if (trailing) segs.push({ type: "word", value: trailing });
  return segs;
}

// Build the nested Divan sub-tree. Mirrors the real BOM structure as
// authored in the BOM Module Builder:
//   Parent: `{DIVAN_HEIGHT} Divan- {SIZE}`  (Upholstery + Packing)
//    ├─ Foam                               (Webbing)
//    │   └─ Frame                          (Framing)
//    │       └─ (WD)                       (Wood Cut)
//    └─ {FABRIC}                           (Fab Sew)
//        └─ {FABRIC} (FC)                  (Fab Cut)
function bfDivanChildren(productCode: string): BOMTemplateWIP[] {
  return [
    {
      id: `wip-dv-foam-${productCode}`,
      wipCode: "Foam",
      codeSegments: bfDivanChildSegs("Foam"),
      wipType: "DIVAN",
      quantity: 1,
      processes: [
        { dept: "Webbing", deptCode: "WEBBING", category: "CAT 1", minutes: 4 },
      ],
      children: [
        {
          id: `wip-dv-frame-${productCode}`,
          wipCode: "Frame",
          codeSegments: bfDivanChildSegs("Frame"),
          wipType: "DIVAN",
          quantity: 1,
          processes: [
            { dept: "Framing", deptCode: "FRAMING", category: "CAT 1", minutes: 20 },
          ],
          children: [
            {
              id: `wip-dv-wd-${productCode}`,
              wipCode: "(WD)",
              codeSegments: bfDivanChildSegs("(WD)"),
              wipType: "DIVAN",
              quantity: 1,
              processes: [
                { dept: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 20 },
              ],
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: `wip-dv-fab-${productCode}`,
      wipCode: "Fabric",
      codeSegments: bfDivanFabricSegs(),
      wipType: "DIVAN",
      quantity: 1,
      processes: [
        { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 1", minutes: 30 },
      ],
      substitutes: [
        { materialId: "fab-pc200", materialName: "PC200", materialCategory: "BM_FABRIC", costDiffPercent: 5, priority: 1, notes: "Slightly heavier weight, same colour range" },
        { materialId: "fab-avani", materialName: "AVANI 01", materialCategory: "BM_FABRIC", costDiffPercent: -3, priority: 2, notes: "Budget alternative, fewer colour options" },
      ],
      children: [
        {
          id: `wip-dv-fc-${productCode}`,
          wipCode: "(FC)",
          codeSegments: bfDivanFabricSegs("(FC)"),
          wipType: "DIVAN",
          quantity: 1,
          processes: [
            { dept: "Fabric Cutting", deptCode: "FAB_CUT", category: "CAT 1", minutes: 15 },
          ],
          children: [],
        },
      ],
    },
  ];
}

// Build the nested HB sub-tree. Mirrors the real BOM structure:
//   Parent: `{PRODUCT_CODE} -HB {TOTAL_HEIGHT}`  (Upholstery + Packing)
//    ├─ Webbing                               (Webbing)
//    │   └─ Frame                             (Framing)
//    │       └─ (WD)                          (Wood Cut)
//    └─ {FABRIC} Foam                         (Foam)
//        └─ {FABRIC}                          (Fab Sew)
//            └─ {FABRIC} (FC)                 (Fab Cut)
function bfHbChildren(productCode: string): BOMTemplateWIP[] {
  return [
    {
      id: `wip-hb-web-${productCode}`,
      wipCode: "Webbing",
      codeSegments: bfHbChildSegs("Webbing"),
      wipType: "HEADBOARD",
      quantity: 1,
      processes: [
        { dept: "Webbing", deptCode: "WEBBING", category: "CAT 7", minutes: 20 },
      ],
      children: [
        {
          id: `wip-hb-frame-${productCode}`,
          wipCode: "Frame",
          codeSegments: bfHbChildSegs("Frame"),
          wipType: "HEADBOARD",
          quantity: 1,
          processes: [
            { dept: "Framing", deptCode: "FRAMING", category: "CAT 4", minutes: 40 },
          ],
          children: [
            {
              id: `wip-hb-wd-${productCode}`,
              wipCode: "(WD)",
              codeSegments: bfHbChildSegs("(WD)"),
              wipType: "HEADBOARD",
              quantity: 1,
              processes: [
                { dept: "Wood Cutting", deptCode: "WOOD_CUT", category: "CAT 5", minutes: 10 },
              ],
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: `wip-hb-foam-${productCode}`,
      wipCode: "Foam",
      codeSegments: bfHbFabricSegs("Foam"),
      wipType: "HEADBOARD",
      quantity: 1,
      processes: [
        { dept: "Foam Bonding", deptCode: "FOAM", category: "CAT 4", minutes: 25 },
      ],
      children: [
        {
          id: `wip-hb-fab-${productCode}`,
          wipCode: "Fabric",
          codeSegments: bfHbFabricSegs(),
          wipType: "HEADBOARD",
          quantity: 1,
          processes: [
            { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 4", minutes: 30 },
          ],
          substitutes: [
            { materialId: "fab-pc200", materialName: "PC200", materialCategory: "BM_FABRIC", costDiffPercent: 5, priority: 1, notes: "Slightly heavier weight, same colour range" },
            { materialId: "fab-avani", materialName: "AVANI 01", materialCategory: "BM_FABRIC", costDiffPercent: -3, priority: 2, notes: "Budget alternative, fewer colour options" },
          ],
          children: [
            {
              id: `wip-hb-fc-${productCode}`,
              wipCode: "(FC)",
              codeSegments: bfHbFabricSegs("(FC)"),
              wipType: "HEADBOARD",
              quantity: 1,
              processes: [
                { dept: "Fabric Cutting", deptCode: "FAB_CUT", category: "CAT 3", minutes: 15 },
              ],
              children: [],
            },
          ],
        },
      ],
    },
  ];
}

// -- Sofa BOM process constants --
// Sofa assembles at Upholstery — Base/Cushion/Arm come out of earlier depts
// as separate pieces, then Upholstery both upholsters and JOINS them into
// one finished sofa. So Upholstery stays per-WIP (one job card + sticker per
// piece), but Packing sits at FG/L1 level (a single job card + sticker for
// the assembled unit — see BOM Builder screenshot at bom-structure tab).
const SF_L1: BOMTemplateProcess[] = [
  { dept: "Packing", deptCode: "PACKING", category: "CAT 1", minutes: 40 },
];

const SF_BASE: BOMTemplateProcess[] = [
  { dept: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 4", minutes: 150 },
  { dept: "Foam Bonding",  deptCode: "FOAM",    category: "CAT 4", minutes: 30  },
  { dept: "Wood Cutting",  deptCode: "WOOD_CUT", category: "CAT 4", minutes: 30 },
  { dept: "Framing",       deptCode: "FRAMING", category: "CAT 4", minutes: 40  },
  { dept: "Webbing",       deptCode: "WEBBING", category: "CAT 4", minutes: 20  },
  { dept: "Upholstery",    deptCode: "UPHOLSTERY", category: "CAT 4", minutes: 45 },
];
const SF_CUSHION: BOMTemplateProcess[] = [
  { dept: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 1", minutes: 40 },
  { dept: "Foam Bonding",  deptCode: "FOAM",    category: "CAT 1", minutes: 15 },
  { dept: "Wood Cutting",  deptCode: "WOOD_CUT", category: "CAT 1", minutes: 15 },
  { dept: "Framing",       deptCode: "FRAMING", category: "CAT 1", minutes: 15 },
  { dept: "Webbing",       deptCode: "WEBBING", category: "CAT 1", minutes: 15 },
  { dept: "Upholstery",    deptCode: "UPHOLSTERY", category: "CAT 1", minutes: 15 },
];
const SF_ARM: BOMTemplateProcess[] = [
  { dept: "Fabric Sewing", deptCode: "FAB_SEW", category: "CAT 2", minutes: 30 },
  { dept: "Foam Bonding",  deptCode: "FOAM",    category: "CAT 2", minutes: 25 },
  { dept: "Wood Cutting",  deptCode: "WOOD_CUT", category: "CAT 1", minutes: 10 },
  { dept: "Framing",       deptCode: "FRAMING", category: "CAT 3", minutes: 25 },
  { dept: "Webbing",       deptCode: "WEBBING", category: "CAT 1", minutes: 10 },
  { dept: "Upholstery",    deptCode: "UPHOLSTERY", category: "CAT 2", minutes: 25 },
];

function mkBedframeBOMTemplate(productCode: string, baseModel: string, sizeLabel: string, sizeCode: string): BOMTemplate {
  const divanQty = (sizeCode === "K" || sizeCode === "Q" || sizeCode === "SK" || sizeCode === "SP") ? 2 : 1;
  // Parent WIP nodes carry ZERO processes — all production work lives
  // on their child sub-WIPs (`(WD)` / `Frame` / `Foam` / `UPH` / `PKG`)
  // so each dept card shows the full suffixed label.
  return {
    id: `bom-tpl-${productCode}`,
    productCode,
    baseModel,
    category: "BEDFRAME",
    l1Processes: BF_L1,
    version: "1.0",
    versionStatus: "ACTIVE" as BOMVersionStatus,
    effectiveFrom: "2026-01-01T00:00:00+08:00",
    wipComponents: [
      {
        id: `wip-dv-${productCode}`,
        wipCode: `Divan ${sizeLabel}`,
        codeSegments: BF_DIVAN_PARENT_SEGS,
        wipType: "DIVAN",
        quantity: divanQty,
        // Parent L2 only holds Packing + Upholstery — matches the
        // BOM Module Builder screenshot. Earlier-flow depts live in
        // the nested L3/L4/L5 children below.
        processes: [
          { dept: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 3", minutes: 15 },
          { dept: "Packing",    deptCode: "PACKING",    category: "CAT 3", minutes: 20 },
        ],
        children: bfDivanChildren(productCode),
      },
      {
        id: `wip-hb-${productCode}`,
        wipCode: `HB ${sizeLabel}`,
        codeSegments: BF_HB_PARENT_SEGS,
        wipType: "HEADBOARD",
        quantity: 1,
        // Parent L2 only holds Upholstery + Packing — everything else
        // lives in the nested child tree below.
        processes: [
          { dept: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 4", minutes: 40 },
          { dept: "Packing",    deptCode: "PACKING",    category: "CAT 2", minutes: 30 },
        ],
        children: bfHbChildren(productCode),
      },
    ],
  };
}

// Default codeSegments for sofa WIPs — mirror what the BOM Builder would
// produce. Base uses module key (`Base 1NA` / `Base 3NA`). Cushion and
// arms are literal labels; arms prepend the side word resolved from the
// product's sizeCode (LHF/RHF) at template-creation time, so they stay
// static segments.
const SF_BASE_SEGS: BOMCodeSegment[] = [
  { type: "word", value: "Base" },
  { type: "variant", variantCategory: "MODULE", value: "", autoDetect: true },
];
const SF_CUSHION_SEGS: BOMCodeSegment[] = [
  { type: "word", value: "Cushion" },
];

function mkSofaBOMTemplate(productCode: string, baseModel: string, sizeCode: string, hasArm: boolean): BOMTemplate {
  // Human-readable codes: `Base 1NA`, `Cushion`, `Left Arm` / `Right Arm`.
  const side = sizeCode.includes("LHF") ? "Left" : sizeCode.includes("RHF") ? "Right" : "Left";
  const wips: BOMTemplateWIP[] = [
    { id: `wip-base-${productCode}`, wipCode: `Base ${sizeCode}`.trim(), codeSegments: SF_BASE_SEGS, wipType: "SOFA_BASE", quantity: 1, processes: SF_BASE, children: [] },
    { id: `wip-cush-${productCode}`, wipCode: `Cushion`, codeSegments: SF_CUSHION_SEGS, wipType: "SOFA_CUSHION", quantity: 1, processes: SF_CUSHION, children: [] },
  ];
  if (hasArm) {
    // Side is baked into the template at creation time — no placeholder
    // for it because there's no "ARM_SIDE" variant in the Builder.
    const armSegs: BOMCodeSegment[] = [
      { type: "word", value: `${side} Arm` },
    ];
    wips.push({ id: `wip-arm-${productCode}`, wipCode: `${side} Arm`, codeSegments: armSegs, wipType: "SOFA_ARMREST", quantity: 1, processes: SF_ARM, children: [] });
  }
  return {
    id: `bom-tpl-${productCode}`,
    productCode,
    baseModel,
    category: "SOFA",
    l1Processes: SF_L1,
    version: "1.0",
    versionStatus: "ACTIVE" as BOMVersionStatus,
    effectiveFrom: "2026-01-01T00:00:00+08:00",
    wipComponents: wips,
  };
}

// Generate BOM templates for all products
export const bomTemplates: BOMTemplate[] = products.map((p) => {
  if (p.category === "BEDFRAME") {
    return mkBedframeBOMTemplate(p.code, p.baseModel, p.sizeLabel, p.sizeCode);
  } else {
    const hasArm = /\dA/.test(p.sizeCode);
    return mkSofaBOMTemplate(p.code, p.baseModel, p.sizeCode, hasArm);
  }
});

// ---------------------------------------------------------------------------
// BOM Version Control — demo v2.0 DRAFT templates for 1003-(K) and 5530-1NA.
// These represent pending BOM revisions that production can preview before
// activating. The v1.0 ACTIVE versions above remain the working BOMs.
// ---------------------------------------------------------------------------
{
  // 1003-(K) v2.0 DRAFT — upgraded plywood & foam density
  const v1 = bomTemplates.find((t) => t.productCode === "1003-(K)" && t.version === "1.0");
  if (v1) {
    bomTemplates.push({
      ...structuredClone(v1),
      id: `bom-tpl-1003-(K)-v2`,
      version: "2.0",
      versionStatus: "DRAFT",
      effectiveFrom: "2026-05-01T00:00:00+08:00",
      changeLog: "Upgraded plywood from 12mm to 15mm; increased foam density to 32D for better durability",
    });
  }

  // 5530-1NA v2.0 DRAFT — reinforced base frame
  const v2 = bomTemplates.find((t) => t.productCode === "5530-1NA" && t.version === "1.0");
  if (v2) {
    bomTemplates.push({
      ...structuredClone(v2),
      id: `bom-tpl-5530-1NA-v2`,
      version: "2.0",
      versionStatus: "DRAFT",
      effectiveFrom: "2026-05-01T00:00:00+08:00",
      changeLog: "Reinforced sofa base frame with cross bracing; added 2mm thicker webbing",
    });
  }
}

// HMR reset marker: bump to force Next.js to re-evaluate this module and
// reset in-memory SO statuses from the source literals (unsticks SOs that
// got mutated to CONFIRMED by the old broken confirm route).
// Bump: 8 — Added BOM version control fields
// ---------------------------------------------------------------------------
// Stub exports — original data wiped by splice tooling, stubbed so API routes
// compile. TODO: restore seeds when needed.
// ---------------------------------------------------------------------------
export const invoices: Invoice[] = [];
export const attendanceRecords: AttendanceRecord[] = [];
export function getNextInvoiceNo(): string {
  return `INV-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Production Lead Times
// ---------------------------------------------------------------------------
// Per-department offsets (in calendar days) used to backward-schedule job
// cards from the customer delivery date when a Sales Order is confirmed.
//
// Example (Bedframe): if the customer wants delivery on 25 Apr, the
// `hookkaExpectedDD` is computed as 25 − 2 = 23 Apr, then each dept card
// is due that many more days earlier — e.g. Upholstery 23 − 2 = 21 Apr,
// Framing 23 − 3 = 20 Apr, Wood Cutting 23 − 4 = 19 Apr, etc.
//
// Values come from the user's lead-time sheet (L/M/N columns). They are
// mutable via PUT /api/production/leadtimes so the Planning page can edit.
export type LeadTimeCategory = "BEDFRAME" | "SOFA";
export type ProductionLeadTimes = Record<LeadTimeCategory, Record<string, number>>;

export const productionLeadTimes: ProductionLeadTimes = {
  BEDFRAME: {
    FAB_CUT: 7,
    FAB_SEW: 5,
    FOAM: 3,
    WOOD_CUT: 4,
    FRAMING: 3,
    UPHOLSTERY: 2,
    PACKING: 2,
    WEBBING: 3,
    HOOKKA_DD: 2,
  },
  SOFA: {
    FAB_CUT: 10,
    FAB_SEW: 8,
    FOAM: 5,
    WOOD_CUT: 7,
    FRAMING: 6,
    UPHOLSTERY: 4,
    PACKING: 3,
    WEBBING: 6,
    HOOKKA_DD: 1,
  },
};

// ---------------------------------------------------------------------------
// BOM WIP Code interpolation
// ---------------------------------------------------------------------------
// The BOM Module Builder lets users design WIP code templates with mixed
// literal words and variant placeholders like `{DIVAN_HEIGHT} Divan- {SIZE}`.
// At SO confirm time we resolve those placeholders against the real SO item
// (divan height, size, fabric...) so the job card's WIP label shows exactly
// what the builder's sample row shows, e.g. `8" Divan- 6FT`.
//
// If an item doesn't carry the value (e.g. no divan height on an accessory),
// the placeholder is dropped so we don't end up with `{DIVAN_HEIGHT} Divan-`.
export type WipCodeContext = {
  productCode?: string;
  sizeLabel?: string;
  sizeCode?: string;
  fabricCode?: string;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
  gapInches?: number | null;
};

function formatInches(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  return `${v}"`;
}

export function resolveWipCode(
  segments: BOMCodeSegment[] | undefined,
  ctx: WipCodeContext,
  fallback: string,
): string {
  if (!segments || segments.length === 0) return fallback;
  const divanH = formatInches(ctx.divanHeightInches);
  const legH = formatInches(ctx.legHeightInches);
  // TOTAL_HEIGHT = gap + divan + leg (matches sales page edit/create formula)
  const totalH = (() => {
    const g = ctx.gapInches ?? 0;
    const d = ctx.divanHeightInches ?? 0;
    const l = ctx.legHeightInches ?? 0;
    const sum = g + d + l;
    return sum > 0 ? `${sum}"` : "";
  })();
  const samples: Record<string, string> = {
    PRODUCT_CODE: ctx.productCode || "",
    SIZE: ctx.sizeLabel || "",
    DIVAN_HEIGHT: divanH,
    LEG_HEIGHT: legH,
    TOTAL_HEIGHT: totalH,
    FABRIC: ctx.fabricCode || "",
    MODULE: ctx.sizeCode || "",
    SPECIAL: "",
  };

  const parts = segments
    .map((s) => {
      if (s.type === "word") return s.value || "";
      const cat = s.variantCategory || "";
      if (s.value && !s.autoDetect) return s.value;
      return samples[cat] || "";
    })
    .filter((p) => p && p.trim().length > 0);

  if (parts.length === 0) return fallback;
  return parts.join(" ");
}

// Helper: given a target customer delivery date (ISO yyyy-mm-dd) and a
// production category, compute the due-date offsets for each dept and the
// derived hookka expected delivery date.
// Returns dept → ISO date, plus the hookkaExpectedDD.
export function computeBackwardSchedule(
  customerDeliveryDate: string,
  category: LeadTimeCategory,
): { hookkaExpectedDD: string; deptDueDates: Record<string, string> } {
  const cfg = productionLeadTimes[category] || productionLeadTimes.BEDFRAME;
  const cdd = new Date(customerDeliveryDate);
  const hookkaDDOffset = cfg.HOOKKA_DD ?? 0;
  const hookkaExpected = new Date(cdd);
  hookkaExpected.setDate(hookkaExpected.getDate() - hookkaDDOffset);
  const hookkaExpectedISO = hookkaExpected.toISOString().split("T")[0];

  const deptDueDates: Record<string, string> = {};
  for (const [deptCode, daysBack] of Object.entries(cfg)) {
    if (deptCode === "HOOKKA_DD") continue;
    const d = new Date(hookkaExpected);
    d.setDate(d.getDate() - daysBack);
    deptDueDates[deptCode] = d.toISOString().split("T")[0];
  }
  return { hookkaExpectedDD: hookkaExpectedISO, deptDueDates };
}

// ---------------------------------------------------------------------------
// Seed bootstrap: auto-confirm BF-imported SOs on module load.
// Mock state lives in memory, so every HMR / server restart resets the BF
// SOs back to DRAFT. This IIFE re-runs the same BOM-driven JobCard generation
// the confirm route does, so after boot the Sales list opens on the
// Confirmed tab with POs already in the dept dashboards.
// Now uses the shared production-order-builder module (lazy-required to
// avoid circular dependency).
// ---------------------------------------------------------------------------
(async function seedConfirmBFOrders() {
  if (productionOrders.length > 0) return;

  // Dynamic import avoids circular dependency: production-order-builder imports
  // from mock-data, but by the time this runs all exports are ready.
  // In the browser we use a lazy dynamic import; the IIFE is converted to async.
  const { buildProductionOrderForSOItem } = await import("./production-order-builder");

  const nowIso = new Date().toISOString();

  for (const order of salesOrders) {
    if (!order.id.startsWith("so-bf-")) continue;
    if (order.status !== "DRAFT") continue;

    for (const item of order.items) {
      if (
        productionOrders.some(
          (po: ProductionOrder) =>
            po.salesOrderId === order.id && po.lineNo === item.lineNo,
        )
      ) {
        continue;
      }

      const { po } = buildProductionOrderForSOItem(order, item);
      productionOrders.push(po);
    }

    order.status = "CONFIRMED";
    order.updatedAt = nowIso;

    soStatusChanges.push({
      id: generateId(),
      soId: order.id,
      fromStatus: "DRAFT",
      toStatus: "CONFIRMED",
      changedBy: "SeedBootstrap",
      timestamp: nowIso,
      notes: "Auto-confirmed at module load",
      autoActions: [],
    });
  }

  // --- Post-seed: advance a subset of POs through UPHOLSTERY ----------
  // Pick the first ~30 production orders and mark all dept cards up to and
  // including UPHOLSTERY as COMPLETED, so the production dashboard shows
  // realistic WIP and the delivery page sees pending deliveries.
  const DEPTS_BEFORE_PACKING = ["FAB_CUT", "FAB_SEW", "FOAM", "WOOD_CUT", "FRAMING", "WEBBING", "UPHOLSTERY"];
  const posToAdvance = productionOrders.slice(0, Math.min(30, productionOrders.length));
  for (const po of posToAdvance) {
    let advancedAny = false;
    for (const jc of po.jobCards) {
      if (DEPTS_BEFORE_PACKING.includes(jc.departmentCode)) {
        jc.status = "COMPLETED";
        jc.completedDate = nowIso;
        jc.prerequisiteMet = true;
        advancedAny = true;
      } else if (jc.departmentCode === "PACKING") {
        jc.status = "WAITING";
        jc.prerequisiteMet = true;
      }
    }
    if (advancedAny) {
      const completedCount = po.jobCards.filter(j => j.status === "COMPLETED").length;
      po.progress = Math.round((completedCount / Math.max(po.jobCards.length, 1)) * 100);
      po.currentDepartment = "PACKING";
      po.status = "IN_PROGRESS";
    }
  }
})();

// ---------------------------------------------------------------------------
// FIFO Costing — mock opening-balance batches.
//
// For every RM with balanceQty > 0 we seed ONE "OPENING" batch carrying the
// full balance at a plausible unit cost (by itemGroup — fabric is priced in
// RM/m, plywood in RM/pcs, etc). This is strictly mock data so the FIFO
// inventory display has something to show before real GRN flow is wired up.
// User said: "历史数据mockup 先之后会清洗" — seed now, clean later.
//
// The cost ledger starts empty — it fills up as real events (GRN, WIP
// complete, delivery) happen in Phase 2+.
// ---------------------------------------------------------------------------

/**
 * Rough unit-cost guess in SEN by raw material itemGroup. These are
 * placeholder figures just to populate the UI — real values come from
 * GRN unit prices once Phase 2 lands.
 */
function guessUnitCostSenByGroup(itemGroup: string, baseUOM: string): number {
  const g = itemGroup.toUpperCase();
  const u = baseUOM.toUpperCase();
  // Fabric — RM 8-35/m depending on material family
  if (g.startsWith("B.M-FABR") || g.startsWith("S.M-FABR") || g.includes("FABRIC")) {
    return u === "MTR" || u === "M" ? 2_500 : 3_500; // 25 / 35 RM
  }
  // Plywood / MDF — RM 40-120/pc depending on thickness
  if (g === "PLYWOOD" || g.includes("PLY") || g.includes("MDF") || g.includes("WOOD")) {
    return 7_500; // RM 75/pc avg
  }
  // Foam — RM 30-60/pc
  if (g === "FOAM" || g.includes("FOAM")) return 4_000; // RM 40
  // Webbing / belt — RM 5-15/m
  if (g.includes("WEB") || g.includes("BELT")) return 800; // RM 8
  // Filler / cotton / dacron — RM 8-20/kg
  if (g.includes("FILL") || g.includes("COTTON") || g.includes("DACRON")) return 1_500; // RM 15
  // Accessories / legs / corners — RM 2-30/pc
  if (g.includes("ACC") || g.includes("LEG") || g.includes("CORNER")) return 1_000; // RM 10
  // Staples / nails / small hardware — RM 20-80/box
  if (g.includes("OTHERS") || g.includes("HARDWARE") || u === "BOX") return 4_000; // RM 40
  // Equipment / consumables
  if (g.includes("EQUIP") || g === "EQUIPMEN") return 5_000; // RM 50
  // Packing — carton/bag/film
  if (g.includes("PACK") || g.includes("CARTON")) return 300; // RM 3
  // Fallback
  return 1_500; // RM 15
}

// Seed date: pretend the opening stock was received 60 days ago so FIFO
// sorts it before any future GRN receipts.
const openingBatchSeedDate = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 60);
  return d.toISOString();
})();

export const rmBatches: RMBatch[] = rawMaterials
  .filter((rm) => rm.balanceQty > 0)
  .map((rm, i) => {
    const unitCostSen = guessUnitCostSenByGroup(rm.itemGroup, rm.baseUOM);
    return {
      id: `rmb-opening-${String(i + 1).padStart(4, "0")}`,
      rmId: rm.id,
      source: "OPENING" as const,
      receivedDate: openingBatchSeedDate,
      originalQty: rm.balanceQty,
      remainingQty: rm.balanceQty,
      unitCostSen,
      createdAt: openingBatchSeedDate,
      notes: "Opening balance seed — replace with real GRN data",
    };
  });

/** Cost ledger — starts empty; Phase 2 will push entries on GRN/issue/completion. */
export const costLedger: CostLedgerEntry[] = [];

/** FG cost layers — populated when production orders complete (Phase 3). */
export const fgBatches: FGBatch[] = [];

