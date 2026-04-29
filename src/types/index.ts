// ============================================================
// HOOKKA ERP - Unified Type Definitions
// Single source of truth for all shared types
// Extracted from src/lib/mock-data.ts
// ============================================================

// --- ENUMS / Union Types ---
export type SOStatus = "DRAFT" | "CONFIRMED" | "IN_PRODUCTION" | "READY_TO_SHIP" | "SHIPPED" | "DELIVERED" | "INVOICED" | "CLOSED" | "ON_HOLD" | "CANCELLED";
export type ProductionStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "ON_HOLD" | "CANCELLED" | "PAUSED";
export type JobCardStatus = "WAITING" | "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "TRANSFERRED" | "BLOCKED";
export type DeliveryStatus = "DRAFT" | "LOADED" | "DISPATCHED" | "IN_TRANSIT" | "SIGNED" | "DELIVERED" | "INVOICED" | "CANCELLED";
export type AttendanceStatus = "PRESENT" | "ABSENT" | "HALF_DAY" | "MEDICAL_LEAVE" | "ANNUAL_LEAVE" | "REST_DAY";
export type StockCategory = "FINISHED_GOOD" | "WIP" | "BM_FABRIC" | "SM_FABRIC" | "PLYWOOD" | "WD_STRIP" | "B_FILLER" | "ACCESSORIES" | "WEBBING" | "PACKING" | "OTHERS";
export type ItemCategory = "SOFA" | "BEDFRAME" | "ACCESSORY";
export type ConsignmentItemStatus = "AT_BRANCH" | "SOLD" | "RETURNED" | "DAMAGED";
export type TransitStatus = "ORDERED" | "SHIPPED" | "IN_TRANSIT" | "CUSTOMS" | "RECEIVED";
export type RDProjectStage = "CONCEPT" | "DESIGN" | "PROTOTYPE" | "TESTING" | "APPROVED" | "PRODUCTION_READY";
export type WIPType = "HEADBOARD" | "DIVAN" | "SOFA_BASE" | "SOFA_CUSHION" | "SOFA_ARMREST" | "SOFA_HEADREST";
export type BOMVersionStatus = "DRAFT" | "ACTIVE" | "OBSOLETE";
export type LeadTimeCategory = "BEDFRAME" | "SOFA";
export type ProductionLeadTimes = Record<LeadTimeCategory, Record<string, number>>;

// --- Departments ---
export type Department = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  sequence: number;
  color: string;
  workingHoursPerDay: number;
  isProduction: boolean;
};

// --- Customers ---
export type DeliveryHub = {
  id: string;
  code: string;
  shortName: string;
  state: string;
  address: string;
  contactName: string;
  phone: string;
  email: string;
  isDefault: boolean;
};

export type Customer = {
  id: string;
  code: string;
  name: string;
  ssmNo: string;
  companyAddress: string;
  creditTerms: string;
  creditLimitSen: number;
  outstandingSen: number;
  isActive: boolean;
  contactName: string;
  phone: string;
  email: string;
  deliveryHubs: DeliveryHub[];
};

// --- BOM Types ---
export type MaterialSubstitute = {
  materialId: string;
  materialName: string;
  materialCategory: string;
  costDiffPercent: number;
  priority: number;
  notes?: string;
};

export type BOMComponent = {
  id: string;
  materialCategory: string;
  materialName: string;
  qtyPerUnit: number;
  unit: string;
  wastePct: number;
  substitutes?: MaterialSubstitute[];
};

export type DeptWorkingTime = {
  departmentCode: string;
  minutes: number;
  category: string;
};

// --- Products ---
export type Product = {
  id: string;
  code: string;
  name: string;
  category: ItemCategory;
  description: string;
  baseModel: string;
  sizeCode: string;
  sizeLabel: string;
  fabricUsage: number;
  unitM3: number;
  status: string;
  costPriceSen: number;
  basePriceSen?: number;
  price1Sen?: number;
  seatHeightPrices?: { height: string; priceSen: number }[];
  productionTimeMinutes: number;
  subAssemblies: string[];
  bomComponents: BOMComponent[];
  deptWorkingTimes: DeptWorkingTime[];
  // --- Optional FG packing sticker / unit-tracking fields (Part A) ---
  // `skuCode` is the SKU printed on the physical packing sticker, e.g. "SB10-KHB-KHJ02".
  // It may differ from the system `code` (which follows internal product-coding rules).
  skuCode?: string;
  // `fabricColor` is the fabric colour code as it appears on the packing sticker
  // (e.g. "FG66151-1"). Separate from `fabricUsage` (meters consumed).
  fabricColor?: string;
  // `pieces` describes how many physical boxes make up ONE unit of this product.
  // Bedframe set = 3 boxes (HB + Divan + Legs); 3-seater sofa = 5 boxes; etc.
  // If absent, treat as 1 piece named "Full Product".
  pieces?: {
    count: number;
    names: string[];
  };
};

// --- Fabrics ---
export type FabricItem = {
  id: string;
  code: string;
  name: string;
  category: string;
  priceSen: number;
  sohMeters: number;
  reorderLevel: number;
};

// --- Raw Materials ---
export type RawMaterial = {
  id: string;
  itemCode: string;
  description: string;
  baseUOM: string;
  itemGroup: string;
  isActive: boolean;
  balanceQty: number;
};

// --- Workers ---
export type Worker = {
  id: string;
  empNo: string;
  name: string;
  departmentId: string;
  departmentCode: string;
  position: string;
  phone: string;
  status: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  joinDate: string;
  icNumber: string;
  passportNumber: string;
  nationality: string;
  otMultiplier?: number;  // OT premium, default 1.5×; 1.0 = no premium
};

// --- Sales Orders ---
export type SalesOrderItem = {
  id: string;
  lineNo: number;
  lineSuffix: string;
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: ItemCategory;
  sizeCode: string;
  sizeLabel: string;
  fabricId: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string;
  specialOrderPriceSen: number;
  basePriceSen: number;
  unitPriceSen: number;
  lineTotalSen: number;
  notes: string;
};

export type SalesOrder = {
  id: string;
  customerPO: string;
  customerPOId: string;
  customerPODate: string;
  customerSO: string;
  customerSOId: string;
  reference: string;
  customerId: string;
  customerName: string;
  customerState: string;
  // Optional delivery hub (branch)
  hubId?: string | null;
  hubName?: string;
  companySO: string;
  companySOId: string;
  companySODate: string;
  customerDeliveryDate: string;
  hookkaExpectedDD: string;
  hookkaDeliveryOrder: string;
  items: SalesOrderItem[];
  subtotalSen: number;
  totalSen: number;
  status: SOStatus;
  /** Saved before transitioning to ON_HOLD so we can resume to the correct state. */
  preHoldStatus?: SOStatus;
  overdue: string;
  notes: string;
  /** Make-to-stock flag — set when the SO was generated as a placeholder for
   *  future customer demand (companySOId uses "SOH-" prefix). When a real
   *  customer order lands, this SO is renamed in-place. Optional for legacy. */
  isStock?: boolean;
  createdAt: string;
  updatedAt: string;
};

// --- Production Orders ---
export type JobCard = {
  id: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  sequence: number;
  status: JobCardStatus;
  dueDate: string;
  wipKey?: string;
  wipCode?: string;
  wipType?: string;
  wipLabel?: string;
  wipQty?: number;
  prerequisiteMet: boolean;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  completedDate: string | null;
  estMinutes: number;
  actualMinutes: number | null;
  category: string;
  productionTimeMinutes: number;
  overdue: string;
  rackingNumber?: string;
};

export type ProductionOrder = {
  id: string;
  poNo: string;
  salesOrderId: string;
  salesOrderNo: string;
  lineNo: number;
  customerPOId: string;
  customerReference: string;
  customerName: string;
  customerState: string;
  companySOId: string;
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: ItemCategory;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string;
  notes: string;
  status: ProductionStatus;
  currentDepartment: string;
  progress: number;
  jobCards: JobCard[];
  startDate: string;
  targetEndDate: string;
  completedDate: string | null;
  rackingNumber: string;
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
  customerId: string;
  customerPOId: string;
  customerName: string;
  customerState: string;
  // Optional delivery hub (branch)
  hubId?: string | null;
  hubName?: string;
  deliveryAddress: string;
  contactPerson: string;
  contactPhone: string;
  deliveryDate: string;
  hookkaExpectedDD: string;
  driverId: string | null;
  driverName: string;
  vehicleNo: string;
  items: DeliveryOrderItem[];
  totalM3: number;
  totalItems: number;
  status: DeliveryStatus;
  overdue: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  remarks: string;
  createdAt: string;
  updatedAt: string;
  // Optional 3PL / lorry dispatch fields
  dropPoints?: number;
  deliveryCostSen?: number;
  lorryId?: string | null;
  lorryName?: string;
  // Optional proof of delivery (set once SIGNED)
  proofOfDelivery?: ProofOfDelivery;
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
  invoiceNo: string;
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
  status: string;
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
  deptBreakdown: { deptCode: string; minutes: number; productCode: string }[];
  notes: string;
};

// One row per (attendance × department × category) — the breakdown rows that
// expand under each Working Hours table row. Hours summed across entries for
// a single attendance should be reconciled against attendance.workingMinutes
// (the clock-vs-breakdown gap surfaces idle time / unaccounted hours).
export type WorkingHourEntry = {
  id: string;
  attendanceId: string;
  workerId: string;
  date: string;                                      // YYYY-MM-DD
  departmentCode: string;
  category: "" | "SOFA" | "BEDFRAME" | "ACCESSORY"; // empty for non-production depts
  hours: number;                                     // decimal, e.g. 7.5
  notes: string;
};

// --- Suppliers & Procurement ---
export type SupplierMaterial = {
  materialCategory: string;
  supplierSKU: string;
  unitPriceSen: number;
  leadTimeDays: number;
  minOrderQty: number;
  priority: "A" | "B" | "C";
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
  status: string;
  rating: number;
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
  poNo: string;
  supplierId: string;
  supplierName: string;
  items: POItem[];
  subtotalSen: number;
  totalSen: number;
  status: string;
  orderDate: string;
  expectedDate: string;
  receivedDate: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

// --- Warehouse ---
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
  rack: string;
  position: string;
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

// --- QC Inspections ---
export type QCDefect = {
  id: string;
  type: "FABRIC" | "ALIGNMENT" | "STRUCTURAL" | "STAIN" | "DIMENSION" | "FINISH" | "OTHER";
  severity: "MINOR" | "MAJOR" | "CRITICAL";
  description: string;
  actionTaken: "REWORK" | "ACCEPT" | "REJECT" | "REPAIR";
};

export type QCInspection = {
  id: string;
  inspectionNo: string;
  productionOrderId: string;
  poNo: string;
  productCode: string;
  productName: string;
  customerName: string;
  department: string;
  inspectorId: string;
  inspectorName: string;
  result: "PASS" | "FAIL" | "CONDITIONAL_PASS";
  defects: QCDefect[];
  notes: string;
  inspectionDate: string;
  createdAt: string;
};

// --- Accounting ---
export type ChartOfAccount = {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  parentCode?: string;
  balance: number;
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

// --- Payroll & Leave ---
export type PayrollRecord = {
  id: string;
  workerId: string;
  workerName: string;
  period: string;
  basicSalarySen: number;
  workingDays: number;
  otHoursWeekday: number;
  otHoursSunday: number;
  otHoursHoliday: number;
  otAmountSen: number;
  grossSalarySen: number;
  epfEmployeeSen: number;
  epfEmployerSen: number;
  socsoEmployeeSen: number;
  socsoEmployerSen: number;
  eisEmployeeSen: number;
  eisEmployerSen: number;
  pcbSen: number;
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

// --- Equipment & Maintenance ---
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

// --- E-Invoices ---
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

// --- MRP ---
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

// --- Bank & Cash Flow ---
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
  amountSen: number;
  type: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";
  reference: string;
  isReconciled: boolean;
  matchedJournalId?: string;
};

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
};

// --- Supplier Multi-SKU & Price Management ---
export type SupplierMaterialBinding = {
  id: string;
  supplierId: string;
  materialCode: string;
  materialName: string;
  supplierSku: string;
  unitPrice: number;
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
  oldPrice: number;
  newPrice: number;
  currency: "MYR" | "RMB";
  changedDate: string;
  changedBy: string;
  reason: string;
  approvalStatus: "APPROVED" | "PENDING" | "REJECTED";
};

export type SupplierScorecard = {
  supplierId: string;
  onTimeRate: number;
  qualityRate: number;
  leadTimeAccuracy: number;
  avgPriceTrend: number;
  overallRating: number;
  lastUpdated: string;
};

// --- Stock Value ---
export type StockAccount = {
  code: string;
  description: string;
  category: "FG" | "WIP" | "RAW_MATERIAL";
};

export type MonthlyStockValue = {
  id: string;
  period: string;
  accountCode: string;
  accountDescription: string;
  openingValue: number;
  purchasesValue: number;
  consumptionValue: number;
  closingValue: number;
  physicalCountValue: number | null;
  variancePercent: number | null;
  status: "DRAFT" | "REVIEWED" | "POSTED";
  postedDate: string | null;
  postedBy: string | null;
};

// --- Consignment ---
export type ConsignmentItem = {
  id: string;
  productId: string;
  productName: string;
  productCode: string;
  quantity: number;
  unitPrice: number;
  status: ConsignmentItemStatus;
  soldDate: string | null;
  returnedDate: string | null;
  // Per-line PO link (migration 0066).
  productionOrderId?: string | null;
};

export type ConsignmentNote = {
  id: string;
  noteNumber: string;
  type: "OUT" | "RETURN";
  customerId: string;
  customerName: string;
  branchName: string;
  items: ConsignmentItem[];
  sentDate: string;
  status: "ACTIVE" | "PARTIALLY_SOLD" | "IN_TRANSIT" | "FULLY_SOLD" | "RETURNED" | "CLOSED";
  totalValue: number;
  notes: string;
  // Carrier metadata (migration 0066). Mirrors DeliveryOrder fields.
  driverId?: string | null;
  driverName?: string;
  driverContactPerson?: string;
  driverPhone?: string;
  vehicleId?: string | null;
  vehicleNo?: string;
  vehicleType?: string;
  // Lifecycle timestamps (migration 0066 + 0078).
  dispatchedAt?: string | null;
  inTransitAt?: string | null;
  deliveredAt?: string | null;
  acknowledgedAt?: string | null;
  // Linkage (migration 0066).
  consignmentOrderId?: string | null;
  hubId?: string | null;
};

// --- Consignment Order (parallel to SalesOrder) ---
// Mirrors SalesOrder field-for-field. Lifecycle is the same up to SHIPPED;
// terminal states (PARTIALLY_SOLD/FULLY_SOLD/RETURNED) are inherited from
// the legacy ConsignmentNote vocabulary so existing UI strings still apply.
export type COStatus =
  | "DRAFT"
  | "CONFIRMED"
  | "IN_PRODUCTION"
  | "READY_TO_SHIP"
  | "SHIPPED"
  | "DELIVERED"
  | "PARTIALLY_SOLD"
  | "FULLY_SOLD"
  | "RETURNED"
  | "CLOSED"
  | "ON_HOLD"
  | "CANCELLED";

export type ConsignmentOrderItem = {
  id: string;
  consignmentOrderId: string;
  lineNo: number;
  lineSuffix: string;
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeCode: string;
  sizeLabel: string;
  fabricId: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string;
  specialOrderPriceSen: number;
  basePriceSen: number;
  unitPriceSen: number;
  lineTotalSen: number;
  notes: string;
};

export type ConsignmentOrder = {
  id: string;
  customerCO: string;
  customerCOId: string;
  customerCODate: string;
  reference: string;
  customerId: string;
  customerName: string;
  customerState: string;
  hubId: string | null;
  hubName: string;
  companyCO: string;
  companyCOId: string;
  companyCODate: string;
  customerDeliveryDate: string;
  hookkaExpectedDD: string;
  subtotalSen: number;
  totalSen: number;
  status: COStatus;
  overdue: string;
  notes: string;
  // Set by POST /:id/cancel; null when the order has never been cancelled.
  // ISO timestamp + free-text reason kept side-by-side so finance / audit
  // can answer "when and why" without a join into status-change log.
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  createdAt: string;
  updatedAt: string;
  items: ConsignmentOrderItem[];
  // SO-compat shims — CO pages were forked from SO pages and reference these.
  // CO has no customer-PO concept; values are always empty/undefined.
  customerPO?: string;
  customerPOId?: string;
  customerPODate?: string;
  customerSO?: string;
  customerSOId?: string;
  customerSODate?: string;
  companySO?: string;
  companySOId?: string;
  companySODate?: string;
  hookkaDeliveryOrder?: string;
  preHoldStatus?: string;
};

// --- Goods In Transit ---
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

// --- Demand Forecasting ---
export type ForecastEntry = {
  id: string;
  productId: string;
  productName: string;
  productCode: string;
  period: string;
  forecastQty: number;
  actualQty: number | null;
  method: "SMA_3" | "SMA_6" | "WMA";
  confidence: number;
  createdDate: string;
};

export type HistoricalSales = {
  productId: string;
  productCode: string;
  productName: string;
  period: string;
  quantity: number;
  revenue: number;
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

// --- R&D ---
export type RDPrototypeType = "FABRIC_SEWING" | "FRAMING";

export type RDProjectType = "DEVELOPMENT" | "IMPROVEMENT" | "CLONE";

export type RDBOMItem = {
  id: string;
  materialCode: string;
  materialName: string;
  qty: number;
  unit: string;
  unitCostSen: number;
};

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

// Row-level shape for the rd_material_issuances table introduced in migration
// 0092. Mirrors the column names returned by the API after camelCase rewrite.
// Kept distinct from RDMaterialIssuance (the legacy JSON shape) so the two
// data sources can coexist while we migrate UIs to the table-backed flow.
export type RdMaterialIssuance = {
  id: string;
  projectId: string;
  rawMaterialId: string;
  materialCode: string;
  materialName: string;
  qty: number;
  unit: string;
  unitCostSen: number;
  totalCostSen: number;
  issuedAt: string;          // DATE — YYYY-MM-DD
  issuedBy: string | null;
  notes: string | null;
  stockMovementId: string | null;
  orgId: string;
  createdAt: string;
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
  // Clone-source fields — populated when projectType === 'CLONE'.
  // The boss bought a competitor's product and we're reverse-engineering it.
  sourceProductName?: string;  // competitor model / SKU
  sourceBrand?: string;        // competitor brand or supplier
  sourcePurchaseRef?: string;  // invoice / receipt no for accounting trace
  sourcePriceSen?: number;     // what we paid for the competitor product, in sen (RM × 100)
  sourceNotes?: string;        // dimensions, specs, why we want to copy
  // Cover photo — glanceable thumbnail of what the project is about. Stored
  // as a data URL (JPEG) compressed client-side via @/lib/image-compress.
  coverPhotoUrl?: string | null;
  createdDate: string;
  // DRAFT = idea backlog, not in Pipeline. Flipped to ACTIVE via the
  // "开启项目" button (POST /api/rd-projects/:id/start). See migration
  // 0090_rd_projects_draft_status.sql.
  status: "DRAFT" | "ACTIVE" | "ON_HOLD" | "COMPLETED" | "CANCELLED";
  // Timestamp the project flipped DRAFT → ACTIVE. Null while in DRAFT.
  startedAt?: string | null;
};

// --- Pricing Config ---
export type DivanHeightOption = {
  height: string;
  surcharge: number;
};

export type SpecialOrderOption = {
  code: string;
  name: string;
  surcharge: number;
  notes: string;
};

export type LegHeightOption = {
  height: string;
  surcharge: number;
};

// --- Customer Hub ---
export type CustomerHub = {
  id: string;
  parentId: string | null;
  creditorCode: string;
  name: string;
  shortName: string;
  state: string;
  pic: string;
  picContact: string;
  picEmail: string;
  deliveryAddress: string;
  isParent: boolean;
  children?: string[];
};

// --- Product Dept Config ---
export type ProductDeptConfig = {
  productCode: string;
  unitM3: number;
  fabricUsage: number;
  price2Sen: number;
  fabCutCategory: string;
  fabCutMinutes: number;
  fabSewCategory: string;
  fabSewMinutes: number;
  woodCutCategory: string;
  woodCutMinutes: number;
  foamCategory: string;
  foamMinutes: number;
  framingCategory: string;
  framingMinutes: number;
  upholsteryCategory: string;
  upholsteryMinutes: number;
  packingCategory: string;
  packingMinutes: number;
  subAssemblies: string[];
  heightsSubAssemblies: string[];
};

// --- Lorry / Fleet ---
export type LorryInfo = {
  id: string;
  name: string;
  plateNumber: string;
  capacity: number;
  driverName: string;
  driverContact: string;
  status: "AVAILABLE" | "IN_USE" | "MAINTENANCE";
};

// --- 3PL Providers ---
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

// --- Proof of Delivery ---
export type ProofOfDelivery = {
  receiverName: string;
  receiverIC: string;
  signatureDataUrl: string;
  photoDataUrls: string[];
  remarks: string;
  deliveredAt: string;
  capturedBy: string;
};

// --- Fabric Tracking ---
export type FabricTracking = {
  id: string;
  fabricCode: string;
  fabricDescription: string;
  fabricCategory: "B.M-FABR" | "S-FABR" | "S.M-FABR" | "LINING" | "WEBBING";
  priceTier: "PRICE_1" | "PRICE_2";
  price: number;
  soh: number;
  poOutstanding: number;
  lastMonthUsage: number;
  oneWeekUsage: number;
  twoWeeksUsage: number;
  oneMonthUsage: number;
  shortage: number;
  reorderPoint: number;
  supplier: string;
  leadTimeDays: number;
};

// --- P&L ---
export type PLEntry = {
  id: string;
  period: string;
  accountCode: string;
  accountName: string;
  category: "REVENUE" | "COGS" | "OPERATING_EXPENSE" | "OTHER_INCOME" | "OTHER_EXPENSE";
  amount: number;
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
  balance: number;
  asOfDate: string;
};

// --- GRN & 3-Way Matching ---
export type GRNItem = {
  poItemIndex: number;
  materialCode: string;
  materialName: string;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string | null;
  unitPrice: number;
};

export type GoodsReceiptNote = {
  id: string;
  grnNumber: string;
  poId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  receiveDate: string;
  receivedBy: string;
  items: GRNItem[];
  totalAmount: number;
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
  poTotal: number;
  grnTotal: number;
  invoiceTotal: number | null;
  variance: number;
  variancePercent: number;
  withinTolerance: boolean;
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

// --- Price Override & SO Status Change ---
export type PriceOverride = {
  id: string;
  soId: string;
  soNumber: string;
  lineIndex: number;
  originalPrice: number;
  overridePrice: number;
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
  autoActions: string[];
};

// --- Credit Notes, Debit Notes, Payment Records ---
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

// --- Payslip Details ---
export type PayslipDetail = {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  departmentCode: string;
  period: string;
  basicSalary: number;
  workingDays: number;
  otWeekdayHours: number;
  otSundayHours: number;
  otPHHours: number;
  hourlyRate: number;
  otWeekdayAmount: number;
  otSundayAmount: number;
  otPHAmount: number;
  totalOT: number;
  allowances: number;
  grossPay: number;
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  totalDeductions: number;
  netPay: number;
  bankAccount: string;
  status: "DRAFT" | "APPROVED" | "PAID";
};

// --- Planning / Scheduling ---
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

// --- BOM Visual Editor ---
export type BOMNode = {
  id: string;
  productCode: string;
  name: string;
  level: number;
  type: "FINISHED_GOOD" | "SUB_ASSEMBLY" | "MATERIAL";
  wipType?: WIPType;
  inventoryCode?: string;
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

// --- BOM Templates ---
export type BOMTemplateProcess = {
  dept: string;
  deptCode: string;
  category: string;
  minutes: number;
};

export type BOMCodeSegment = {
  type: "word" | "variant";
  variantCategory?: string;
  value: string;
  autoDetect?: boolean;
};

export type BOMTemplateWIP = {
  id: string;
  wipCode: string;
  codeSegments?: BOMCodeSegment[];
  wipType: WIPType;
  quantity: number;
  processes: BOMTemplateProcess[];
  children?: BOMTemplateWIP[];
  substitutes?: MaterialSubstitute[];
};

export type BOMTemplate = {
  id: string;
  productCode: string;
  baseModel: string;
  category: "BEDFRAME" | "SOFA";
  l1Processes: BOMTemplateProcess[];
  wipComponents: BOMTemplateWIP[];
  version: string;
  versionStatus: BOMVersionStatus;
  effectiveFrom: string;
  effectiveTo?: string;
  changeLog?: string;
  // Fields used by BOM page but not in mock-data canonical type
  l1Materials?: { code: string; name: string; qty: number; unit: string; wastePct: number; costPerUnit: number; inventoryCode?: string }[];
};

// --- WIP Code Context ---
export type WipCodeContext = {
  productCode?: string;
  sizeLabel?: string;
  sizeCode?: string;
  fabricCode?: string;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
  gapInches?: number | null;
};

// ---------------------------------------------------------------------------
// FIFO Costing — RM batch layers, cost ledger, FG batch layers.
//
// Conceptual model (see also src/lib/costing.ts):
//   - Every RM receipt (GRN or opening-balance seed) creates ONE RMBatch row.
//     `remainingQty` decrements as material is consumed, FIFO from the oldest
//     `receivedDate` with `remainingQty > 0`.
//   - Every cost-bearing event writes a CostLedgerEntry. The ledger is the
//     audit trail: you can sum it to get stock value, COGS, WIP accumulated
//     cost, etc.
//   - On WIP completion the production order's BOM is auto-consumed — RM
//     gets FIFO-deducted, labor is computed from department minutes × the
//     month's per-minute rate (which floats with calendar Mon–Sat count).
//   - On FG completion the accumulated material + labor rolls into an
//     FGBatch layer. Deliveries then FIFO-consume FG batches for COGS.
// ---------------------------------------------------------------------------

export type RMBatchSource = "OPENING" | "GRN" | "ADJUSTMENT";

// A cost layer for one RM. Each receipt (or opening-balance seed) makes one.
// FIFO consumption walks these in `receivedDate` ascending order.
export type RMBatch = {
  id: string;
  rmId: string;                 // → RawMaterial.id
  source: RMBatchSource;
  sourceRefId?: string;         // e.g. GRN id for source=GRN
  receivedDate: string;         // ISO — FIFO order key
  originalQty: number;          // as received
  remainingQty: number;         // decrements on issue; 0 = fully consumed
  unitCostSen: number;          // cost per unit at time of receipt, in sen
  createdAt: string;
  notes?: string;
};

export type CostLedgerEntryType =
  | "RM_RECEIPT"        // GRN or opening balance — + RM inventory
  | "RM_ISSUE"          // FIFO consume when WIP completes — - RM, + WIP
  | "LABOR_POSTED"      // labor minutes × rate → + WIP
  | "FG_COMPLETED"      // WIP accum rolled into FG batch — - WIP, + FG
  | "FG_DELIVERED"      // DO posted — - FG, → COGS
  | "ADJUSTMENT";       // manual correction

export type CostLedgerItemType = "RM" | "WIP" | "FG";

// Single source of truth for every cost-bearing event.
// Month-end stock value and COGS both aggregate from this table.
export type CostLedgerEntry = {
  id: string;
  date: string;                 // ISO timestamp
  type: CostLedgerEntryType;
  itemType: CostLedgerItemType;
  itemId: string;               // rmId / productId / productionOrderId depending on itemType
  batchId?: string;             // RMBatch.id or FGBatch.id when applicable
  qty: number;                  // positive for IN, negative for OUT (or rely on `direction`)
  direction: "IN" | "OUT";
  unitCostSen: number;
  totalCostSen: number;         // qty × unitCostSen (cached for aggregation)
  refType?: string;             // e.g. "GRN", "ProductionOrder", "DeliveryOrder"
  refId?: string;
  notes?: string;
};

// Cost layer for finished goods, populated when a production order completes.
// Deliveries FIFO-consume these to produce COGS entries.
export type FGBatch = {
  id: string;
  productId: string;            // → Product.id
  productionOrderId: string;
  completedDate: string;        // ISO — FIFO order key
  originalQty: number;
  remainingQty: number;
  unitCostSen: number;          // (materials FIFO'd + labor + overhead) / originalQty
  materialCostSen: number;      // breakdown — for drill-down display
  laborCostSen: number;
  overheadCostSen: number;      // currently 0 — reserved for future use
  createdAt: string;
};

// Global costing configuration. Lives in mock-data / settings; today it's
// a single flat rate (RM 2050/month) but the per-minute rate is recomputed
// for each month based on how many Mon–Sat fall in it.
export type CostingConfig = {
  /** Monthly base salary used for labor rate, in sen. Default: 205_000 (RM 2050). */
  baseSalarySen: number;
  /** Hours per working day. Default: 9. */
  hoursPerDay: number;
  /** Working weekday indices (0=Sun..6=Sat). Default: [1..6] = Mon–Sat. */
  workingDaysOfWeek: number[];
  /** Whether overhead is applied to FG cost. Today: false. */
  includeOverhead: boolean;
};
