-- ============================================================================
-- HOOKKA ERP — Cloudflare D1 (SQLite) schema
-- Generated from src/types/index.ts and src/lib/mock-data.ts
--
-- Conventions:
--   * Money fields ending in `Sen` → INTEGER (cents, no decimals).
--   * Dates/timestamps → TEXT (ISO 8601).
--   * Booleans       → INTEGER (0 / 1).
--   * Enums / string-literal unions → TEXT with CHECK constraints.
--   * Nested arrays → child tables w/ FK + ON DELETE CASCADE.
--   * Complex non-queried nested objects → JSON blob in a TEXT column.
-- ============================================================================

-- ############################################################################
-- 1. MASTERS — customers, products, workers, suppliers, raw materials, etc.
-- ############################################################################

-- --- Departments ------------------------------------------------------------
CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  shortName TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  color TEXT NOT NULL,
  workingHoursPerDay INTEGER NOT NULL
);

-- --- Customers --------------------------------------------------------------
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  ssmNo TEXT,
  companyAddress TEXT,
  creditTerms TEXT,
  creditLimitSen INTEGER NOT NULL DEFAULT 0,
  outstandingSen INTEGER NOT NULL DEFAULT 0,
  isActive INTEGER NOT NULL DEFAULT 1,
  contactName TEXT,
  phone TEXT,
  email TEXT
);

CREATE TABLE delivery_hubs (
  id TEXT PRIMARY KEY,
  customerId TEXT NOT NULL,
  code TEXT NOT NULL,
  shortName TEXT NOT NULL,
  state TEXT,
  address TEXT,
  contactName TEXT,
  phone TEXT,
  email TEXT,
  isDefault INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (customerId) REFERENCES customers(id) ON DELETE CASCADE
);

-- --- Customer Hubs (hierarchical customer-branch directory) -----------------
CREATE TABLE customer_hubs (
  id TEXT PRIMARY KEY,
  parentId TEXT,
  creditorCode TEXT NOT NULL,
  name TEXT NOT NULL,
  shortName TEXT NOT NULL,
  state TEXT,
  pic TEXT,
  picContact TEXT,
  picEmail TEXT,
  deliveryAddress TEXT,
  isParent INTEGER NOT NULL DEFAULT 0,
  children TEXT,  -- JSON string[]
  FOREIGN KEY (parentId) REFERENCES customer_hubs(id) ON DELETE SET NULL
);

-- --- Products ---------------------------------------------------------------
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('SOFA','BEDFRAME','ACCESSORY')),
  description TEXT,
  baseModel TEXT,
  sizeCode TEXT,
  sizeLabel TEXT,
  fabricUsage REAL NOT NULL DEFAULT 0,
  unitM3 REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  costPriceSen INTEGER NOT NULL DEFAULT 0,
  basePriceSen INTEGER,
  price1Sen INTEGER,
  productionTimeMinutes INTEGER NOT NULL DEFAULT 0,
  subAssemblies TEXT,  -- JSON string[]
  skuCode TEXT,
  fabricColor TEXT,
  pieces TEXT,          -- JSON { count, names[] }
  seatHeightPrices TEXT -- JSON [{height, priceSen}]
);

CREATE TABLE bom_components (
  id TEXT PRIMARY KEY,
  productId TEXT NOT NULL,
  materialCategory TEXT NOT NULL,
  materialName TEXT NOT NULL,
  qtyPerUnit REAL NOT NULL,
  unit TEXT NOT NULL,
  wastePct REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE material_substitutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bomComponentId TEXT,       -- nullable: also used by BOMTemplateWIP
  bomTemplateWipId TEXT,     -- nullable
  materialId TEXT,
  materialName TEXT NOT NULL,
  materialCategory TEXT,
  costDiffPercent REAL NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  FOREIGN KEY (bomComponentId) REFERENCES bom_components(id) ON DELETE CASCADE
);

CREATE TABLE dept_working_times (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  productId TEXT NOT NULL,
  departmentCode TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  category TEXT,
  FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
);

-- --- Product Dept Configs (GSheet per-product working time defaults) --------
CREATE TABLE product_dept_configs (
  productCode TEXT PRIMARY KEY,
  unitM3 REAL NOT NULL DEFAULT 0,
  fabricUsage REAL NOT NULL DEFAULT 0,
  price2Sen INTEGER NOT NULL DEFAULT 0,
  fabCutCategory TEXT,
  fabCutMinutes INTEGER,
  fabSewCategory TEXT,
  fabSewMinutes INTEGER,
  woodCutCategory TEXT,
  woodCutMinutes INTEGER,
  foamCategory TEXT,
  foamMinutes INTEGER,
  framingCategory TEXT,
  framingMinutes INTEGER,
  upholsteryCategory TEXT,
  upholsteryMinutes INTEGER,
  packingCategory TEXT,
  packingMinutes INTEGER,
  subAssemblies TEXT,         -- JSON string[]
  heightsSubAssemblies TEXT   -- JSON string[]
);

-- --- Fabrics ----------------------------------------------------------------
CREATE TABLE fabrics (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  priceSen INTEGER NOT NULL DEFAULT 0,
  sohMeters REAL NOT NULL DEFAULT 0,
  reorderLevel REAL NOT NULL DEFAULT 0
);

-- --- Fabric Tracking (richer analytics view) --------------------------------
CREATE TABLE fabric_trackings (
  id TEXT PRIMARY KEY,
  fabricCode TEXT NOT NULL,
  fabricDescription TEXT,
  fabricCategory TEXT CHECK (fabricCategory IN ('B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING')),
  priceTier TEXT CHECK (priceTier IN ('PRICE_1','PRICE_2')),
  price REAL NOT NULL DEFAULT 0,
  soh REAL NOT NULL DEFAULT 0,
  poOutstanding REAL NOT NULL DEFAULT 0,
  lastMonthUsage REAL NOT NULL DEFAULT 0,
  oneWeekUsage REAL NOT NULL DEFAULT 0,
  twoWeeksUsage REAL NOT NULL DEFAULT 0,
  oneMonthUsage REAL NOT NULL DEFAULT 0,
  shortage REAL NOT NULL DEFAULT 0,
  reorderPoint REAL NOT NULL DEFAULT 0,
  supplier TEXT,
  leadTimeDays INTEGER NOT NULL DEFAULT 0
);

-- --- Raw Materials ----------------------------------------------------------
CREATE TABLE raw_materials (
  id TEXT PRIMARY KEY,
  itemCode TEXT NOT NULL,
  description TEXT NOT NULL,
  baseUOM TEXT NOT NULL,
  itemGroup TEXT NOT NULL,
  isActive INTEGER NOT NULL DEFAULT 1,
  balanceQty REAL NOT NULL DEFAULT 0
);

-- --- Workers / Employees ----------------------------------------------------
CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  empNo TEXT NOT NULL,
  name TEXT NOT NULL,
  departmentId TEXT,
  departmentCode TEXT,
  position TEXT,
  phone TEXT,
  status TEXT NOT NULL,
  basicSalarySen INTEGER NOT NULL DEFAULT 0,
  workingHoursPerDay INTEGER NOT NULL DEFAULT 9,
  workingDaysPerMonth INTEGER NOT NULL DEFAULT 26,
  joinDate TEXT,
  icNumber TEXT,
  passportNumber TEXT,
  nationality TEXT,
  FOREIGN KEY (departmentId) REFERENCES departments(id) ON DELETE SET NULL
);

-- --- Worker portal auth (PIN + opaque bearer tokens) ------------------------
-- PIN stored plaintext because this is a shop-floor convenience login, not
-- real auth. Replace with bcrypt when worker portal hits real auth.
CREATE TABLE worker_pins (
  workerId TEXT PRIMARY KEY,
  pin TEXT NOT NULL,
  updatedAt TEXT,
  FOREIGN KEY (workerId) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE TABLE worker_tokens (
  token TEXT PRIMARY KEY,
  workerId TEXT NOT NULL,
  issuedAt INTEGER NOT NULL,
  FOREIGN KEY (workerId) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE INDEX idx_worker_tokens_workerId ON worker_tokens(workerId);

-- --- Suppliers --------------------------------------------------------------
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  contactPerson TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  state TEXT,
  paymentTerms TEXT,
  status TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE supplier_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplierId TEXT NOT NULL,
  materialCategory TEXT NOT NULL,
  supplierSKU TEXT NOT NULL,
  unitPriceSen INTEGER NOT NULL DEFAULT 0,
  leadTimeDays INTEGER NOT NULL DEFAULT 0,
  minOrderQty INTEGER NOT NULL DEFAULT 0,
  priority TEXT CHECK (priority IN ('A','B','C')),
  FOREIGN KEY (supplierId) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_material_bindings (
  id TEXT PRIMARY KEY,
  supplierId TEXT NOT NULL,
  materialCode TEXT NOT NULL,
  materialName TEXT NOT NULL,
  supplierSku TEXT NOT NULL,
  unitPrice INTEGER NOT NULL DEFAULT 0,
  currency TEXT CHECK (currency IN ('MYR','RMB')),
  leadTimeDays INTEGER NOT NULL DEFAULT 0,
  paymentTerms TEXT,
  moq INTEGER NOT NULL DEFAULT 0,
  priceValidFrom TEXT,
  priceValidTo TEXT,
  isMainSupplier INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (supplierId) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE price_histories (
  id TEXT PRIMARY KEY,
  bindingId TEXT NOT NULL,
  supplierId TEXT NOT NULL,
  materialCode TEXT NOT NULL,
  oldPrice INTEGER NOT NULL DEFAULT 0,
  newPrice INTEGER NOT NULL DEFAULT 0,
  currency TEXT CHECK (currency IN ('MYR','RMB')),
  changedDate TEXT NOT NULL,
  changedBy TEXT NOT NULL,
  reason TEXT,
  approvalStatus TEXT CHECK (approvalStatus IN ('APPROVED','PENDING','REJECTED')),
  FOREIGN KEY (bindingId) REFERENCES supplier_material_bindings(id) ON DELETE CASCADE,
  FOREIGN KEY (supplierId) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_scorecards (
  supplierId TEXT PRIMARY KEY,
  onTimeRate REAL NOT NULL DEFAULT 0,
  qualityRate REAL NOT NULL DEFAULT 0,
  leadTimeAccuracy REAL NOT NULL DEFAULT 0,
  avgPriceTrend REAL NOT NULL DEFAULT 0,
  overallRating REAL NOT NULL DEFAULT 0,
  lastUpdated TEXT,
  FOREIGN KEY (supplierId) REFERENCES suppliers(id) ON DELETE CASCADE
);

-- --- Organisations ----------------------------------------------------------
CREATE TABLE organisations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK (code IN ('HOOKKA','OHANA')),
  name TEXT NOT NULL,
  regNo TEXT,
  tin TEXT,
  msic TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  transferPricingPct REAL NOT NULL DEFAULT 0,
  isActive INTEGER NOT NULL DEFAULT 1
);

-- --- Pricing config tables (small lookups, no FKs) --------------------------
CREATE TABLE divan_height_options (
  height TEXT PRIMARY KEY,
  surcharge INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE leg_height_options (
  height TEXT PRIMARY KEY,
  surcharge INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE special_order_options (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  surcharge INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

-- --- Lorry / Fleet / 3PL ----------------------------------------------------
CREATE TABLE lorries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plateNumber TEXT,
  capacity REAL NOT NULL DEFAULT 0,
  driverName TEXT,
  driverContact TEXT,
  status TEXT CHECK (status IN ('AVAILABLE','IN_USE','MAINTENANCE'))
);

CREATE TABLE three_pl_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  contactPerson TEXT,
  vehicleNo TEXT,
  vehicleType TEXT,
  capacityM3 REAL NOT NULL DEFAULT 0,
  ratePerTripSen INTEGER NOT NULL DEFAULT 0,
  ratePerExtraDropSen INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('ACTIVE','INACTIVE','ON_LEAVE')),
  remarks TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- ############################################################################
-- 2. TRANSACTIONS — sales orders, purchase orders, delivery orders, invoices
-- ############################################################################

-- --- Sales Orders -----------------------------------------------------------
CREATE TABLE sales_orders (
  id TEXT PRIMARY KEY,
  customerPO TEXT,
  customerPOId TEXT,
  customerPODate TEXT,
  customerSO TEXT,
  customerSOId TEXT,
  reference TEXT,
  customerId TEXT NOT NULL,
  customerName TEXT NOT NULL,
  customerState TEXT,
  hubId TEXT,
  hubName TEXT,
  companySO TEXT,
  companySOId TEXT,
  companySODate TEXT,
  customerDeliveryDate TEXT,
  hookkaExpectedDD TEXT,
  hookkaDeliveryOrder TEXT,
  subtotalSen INTEGER NOT NULL DEFAULT 0,
  totalSen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','IN_PRODUCTION','READY_TO_SHIP','SHIPPED','DELIVERED','INVOICED','CLOSED','ON_HOLD','CANCELLED')),
  overdue TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (customerId) REFERENCES customers(id),
  FOREIGN KEY (hubId) REFERENCES delivery_hubs(id) ON DELETE SET NULL
);

CREATE TABLE sales_order_items (
  id TEXT PRIMARY KEY,
  salesOrderId TEXT NOT NULL,
  lineNo INTEGER NOT NULL,
  lineSuffix TEXT,
  productId TEXT,
  productCode TEXT,
  productName TEXT,
  itemCategory TEXT CHECK (itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')),
  sizeCode TEXT,
  sizeLabel TEXT,
  fabricId TEXT,
  fabricCode TEXT,
  quantity INTEGER NOT NULL,
  gapInches INTEGER,
  divanHeightInches INTEGER,
  divanPriceSen INTEGER NOT NULL DEFAULT 0,
  legHeightInches INTEGER,
  legPriceSen INTEGER NOT NULL DEFAULT 0,
  specialOrder TEXT,
  specialOrderPriceSen INTEGER NOT NULL DEFAULT 0,
  basePriceSen INTEGER NOT NULL DEFAULT 0,
  unitPriceSen INTEGER NOT NULL DEFAULT 0,
  lineTotalSen INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  -- NOTE: productId is a variant code (e.g. "prod-1003-A---K-") that is
  -- dynamically generated from size/fabric/config combinations. It is
  -- intentionally not enforced against the products catalog.
  FOREIGN KEY (salesOrderId) REFERENCES sales_orders(id) ON DELETE CASCADE
);

-- --- Purchase Orders --------------------------------------------------------
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  poNo TEXT NOT NULL,
  supplierId TEXT NOT NULL,
  supplierName TEXT,
  subtotalSen INTEGER NOT NULL DEFAULT 0,
  totalSen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  orderDate TEXT,
  expectedDate TEXT,
  receivedDate TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (supplierId) REFERENCES suppliers(id)
);

CREATE TABLE purchase_order_items (
  id TEXT PRIMARY KEY,
  purchaseOrderId TEXT NOT NULL,
  materialCategory TEXT,
  materialName TEXT,
  supplierSKU TEXT,
  quantity REAL NOT NULL,
  unitPriceSen INTEGER NOT NULL DEFAULT 0,
  totalSen INTEGER NOT NULL DEFAULT 0,
  receivedQty REAL NOT NULL DEFAULT 0,
  unit TEXT,
  FOREIGN KEY (purchaseOrderId) REFERENCES purchase_orders(id) ON DELETE CASCADE
);

-- --- Delivery Orders --------------------------------------------------------
CREATE TABLE delivery_orders (
  id TEXT PRIMARY KEY,
  doNo TEXT NOT NULL,
  salesOrderId TEXT,
  companySO TEXT,
  companySOId TEXT,
  customerId TEXT NOT NULL,
  customerPOId TEXT,
  customerName TEXT NOT NULL,
  customerState TEXT,
  hubId TEXT,
  hubName TEXT,
  deliveryAddress TEXT,
  contactPerson TEXT,
  contactPhone TEXT,
  deliveryDate TEXT,
  hookkaExpectedDD TEXT,
  driverId TEXT,
  driverName TEXT,
  vehicleNo TEXT,
  totalM3 REAL NOT NULL DEFAULT 0,
  totalItems INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','LOADED','DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED','CANCELLED')),
  overdue TEXT,
  dispatchedAt TEXT,
  deliveredAt TEXT,
  remarks TEXT,
  dropPoints INTEGER,
  deliveryCostSen INTEGER,
  lorryId TEXT,
  lorryName TEXT,
  doQrCode TEXT,
  fgUnitIds TEXT,             -- JSON string[]
  signedAt TEXT,
  signedByWorkerId TEXT,
  signedByWorkerName TEXT,
  proofOfDelivery TEXT,       -- JSON ProofOfDelivery
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (salesOrderId) REFERENCES sales_orders(id),
  FOREIGN KEY (customerId) REFERENCES customers(id),
  FOREIGN KEY (hubId) REFERENCES delivery_hubs(id) ON DELETE SET NULL
);

CREATE TABLE delivery_order_items (
  id TEXT PRIMARY KEY,
  deliveryOrderId TEXT NOT NULL,
  productionOrderId TEXT,
  poNo TEXT,
  productCode TEXT,
  productName TEXT,
  sizeLabel TEXT,
  fabricCode TEXT,
  quantity INTEGER NOT NULL,
  itemM3 REAL NOT NULL DEFAULT 0,
  rackingNumber TEXT,
  packingStatus TEXT,
  salesOrderNo TEXT,
  FOREIGN KEY (deliveryOrderId) REFERENCES delivery_orders(id) ON DELETE CASCADE
);

-- --- Invoices ---------------------------------------------------------------
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  invoiceNo TEXT NOT NULL,
  deliveryOrderId TEXT,
  doNo TEXT,
  salesOrderId TEXT,
  companySOId TEXT,
  customerId TEXT NOT NULL,
  customerName TEXT NOT NULL,
  customerState TEXT,
  hubId TEXT,
  hubName TEXT,
  subtotalSen INTEGER NOT NULL DEFAULT 0,
  totalSen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  invoiceDate TEXT,
  dueDate TEXT,
  paidAmount INTEGER NOT NULL DEFAULT 0,
  paymentDate TEXT,
  paymentMethod TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (salesOrderId) REFERENCES sales_orders(id),
  FOREIGN KEY (deliveryOrderId) REFERENCES delivery_orders(id),
  FOREIGN KEY (customerId) REFERENCES customers(id),
  FOREIGN KEY (hubId) REFERENCES delivery_hubs(id) ON DELETE SET NULL
);

CREATE TABLE invoice_items (
  id TEXT PRIMARY KEY,
  invoiceId TEXT NOT NULL,
  productCode TEXT,
  productName TEXT,
  sizeLabel TEXT,
  fabricCode TEXT,
  quantity INTEGER NOT NULL,
  unitPriceSen INTEGER NOT NULL DEFAULT 0,
  totalSen INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (invoiceId) REFERENCES invoices(id) ON DELETE CASCADE
);

CREATE TABLE invoice_payments (
  id TEXT PRIMARY KEY,
  invoiceId TEXT NOT NULL,
  date TEXT NOT NULL,
  amountSen INTEGER NOT NULL DEFAULT 0,
  method TEXT CHECK (method IN ('CASH','CHEQUE','BANK_TRANSFER','CREDIT_CARD','E_WALLET')),
  reference TEXT,
  FOREIGN KEY (invoiceId) REFERENCES invoices(id) ON DELETE CASCADE
);

-- --- Credit Notes, Debit Notes, Payment Records -----------------------------
CREATE TABLE credit_notes (
  id TEXT PRIMARY KEY,
  noteNumber TEXT NOT NULL,
  invoiceId TEXT,
  invoiceNumber TEXT,
  customerId TEXT NOT NULL,
  customerName TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT CHECK (reason IN ('RETURN','PRICE_ADJUSTMENT','DAMAGE','OVERCHARGE','OTHER')),
  reasonDetail TEXT,
  totalAmount INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('DRAFT','APPROVED','POSTED')),
  approvedBy TEXT,
  items TEXT,     -- JSON [{description, quantity, unitPrice, total}]
  FOREIGN KEY (customerId) REFERENCES customers(id)
);

CREATE TABLE debit_notes (
  id TEXT PRIMARY KEY,
  noteNumber TEXT NOT NULL,
  invoiceId TEXT,
  invoiceNumber TEXT,
  customerId TEXT NOT NULL,
  customerName TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT CHECK (reason IN ('UNDERCHARGE','ADDITIONAL_CHARGE','PRICE_ADJUSTMENT','OTHER')),
  reasonDetail TEXT,
  totalAmount INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('DRAFT','APPROVED','POSTED')),
  approvedBy TEXT,
  items TEXT,     -- JSON
  FOREIGN KEY (customerId) REFERENCES customers(id)
);

CREATE TABLE payment_records (
  id TEXT PRIMARY KEY,
  receiptNumber TEXT NOT NULL,
  customerId TEXT NOT NULL,
  customerName TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT CHECK (method IN ('BANK_TRANSFER','CHEQUE','CASH','CREDIT_CARD')),
  reference TEXT,
  status TEXT CHECK (status IN ('RECEIVED','CLEARED','BOUNCED')),
  allocations TEXT,  -- JSON [{invoiceId, invoiceNumber, amount}]
  FOREIGN KEY (customerId) REFERENCES customers(id)
);

-- --- E-Invoices (MyInvois submissions) --------------------------------------
CREATE TABLE e_invoices (
  id TEXT PRIMARY KEY,
  invoiceId TEXT,
  invoiceNo TEXT NOT NULL,
  customerName TEXT,
  customerTIN TEXT,
  submissionId TEXT,
  uuid TEXT,
  status TEXT CHECK (status IN ('PENDING','SUBMITTED','VALID','INVALID','CANCELLED')),
  submittedAt TEXT,
  validatedAt TEXT,
  errorMessage TEXT,
  xmlContent TEXT,
  totalExcludingTax INTEGER NOT NULL DEFAULT 0,
  taxAmount INTEGER NOT NULL DEFAULT 0,
  totalIncludingTax INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
  -- NOTE: invoiceId is intentionally not FK-enforced; legacy / standalone
  -- e-invoices may reference invoices outside the live set (or be empty).
);

-- ############################################################################
-- 3. PRODUCTION — production orders, job cards, piece pics, WIP, FG, batches
-- ############################################################################

CREATE TABLE production_orders (
  id TEXT PRIMARY KEY,
  poNo TEXT NOT NULL,
  salesOrderId TEXT,
  salesOrderNo TEXT,
  lineNo INTEGER NOT NULL,
  customerPOId TEXT,
  customerReference TEXT,
  customerName TEXT,
  customerState TEXT,
  companySOId TEXT,
  productId TEXT,
  productCode TEXT,
  productName TEXT,
  itemCategory TEXT CHECK (itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')),
  sizeCode TEXT,
  sizeLabel TEXT,
  fabricCode TEXT,
  quantity INTEGER NOT NULL,
  gapInches INTEGER,
  divanHeightInches INTEGER,
  legHeightInches INTEGER,
  specialOrder TEXT,
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','ON_HOLD','CANCELLED','PAUSED')),
  currentDepartment TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  startDate TEXT,
  targetEndDate TEXT,
  completedDate TEXT,
  rackingNumber TEXT,
  stockedIn INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (salesOrderId) REFERENCES sales_orders(id),
  FOREIGN KEY (productId) REFERENCES products(id)
);

CREATE TABLE job_cards (
  id TEXT PRIMARY KEY,
  productionOrderId TEXT NOT NULL,
  departmentId TEXT,
  departmentCode TEXT,
  departmentName TEXT,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WAITING','IN_PROGRESS','PAUSED','COMPLETED','TRANSFERRED','BLOCKED')),
  dueDate TEXT,
  wipKey TEXT,
  wipCode TEXT,
  wipType TEXT,
  wipLabel TEXT,
  wipQty INTEGER,
  prerequisiteMet INTEGER NOT NULL DEFAULT 0,
  pic1Id TEXT,
  pic1Name TEXT,
  pic2Id TEXT,
  pic2Name TEXT,
  completedDate TEXT,
  estMinutes INTEGER NOT NULL DEFAULT 0,
  actualMinutes INTEGER,
  category TEXT,
  productionTimeMinutes INTEGER NOT NULL DEFAULT 0,
  overdue TEXT,
  rackingNumber TEXT,
  FOREIGN KEY (productionOrderId) REFERENCES production_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (departmentId) REFERENCES departments(id)
);

CREATE TABLE piece_pics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jobCardId TEXT NOT NULL,
  pieceNo INTEGER NOT NULL,
  pic1Id TEXT,
  pic1Name TEXT,
  pic2Id TEXT,
  pic2Name TEXT,
  completedAt TEXT,
  lastScanAt TEXT,
  boundStickerKey TEXT,
  FOREIGN KEY (jobCardId) REFERENCES job_cards(id) ON DELETE CASCADE
);

-- --- WIP inventory & FG units ------------------------------------------------
CREATE TABLE wip_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  relatedProduct TEXT,
  deptStatus TEXT,
  stockQty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);

CREATE TABLE fg_units (
  id TEXT PRIMARY KEY,
  unitSerial TEXT NOT NULL,
  shortCode TEXT,
  soId TEXT,
  soNo TEXT,
  soLineNo INTEGER,
  poId TEXT,
  poNo TEXT,
  productCode TEXT,
  productName TEXT,
  unitNo INTEGER,
  totalUnits INTEGER,
  pieceNo INTEGER,
  totalPieces INTEGER,
  pieceName TEXT,
  customerName TEXT,
  customerHub TEXT,
  mfdDate TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PENDING_UPHOLSTERY','UPHOLSTERED','PACKED','LOADED','DELIVERED','RETURNED')),
  packerId TEXT,
  packerName TEXT,
  packedAt TEXT,
  loadedAt TEXT,
  deliveredAt TEXT,
  returnedAt TEXT,
  batchId TEXT,
  sourcePieceIndex INTEGER,
  sourceSlotIndex INTEGER,
  upholsteredBy TEXT,
  upholsteredByName TEXT,
  upholsteredAt TEXT,
  doId TEXT,
  FOREIGN KEY (soId) REFERENCES sales_orders(id),
  FOREIGN KEY (poId) REFERENCES production_orders(id),
  FOREIGN KEY (doId) REFERENCES delivery_orders(id) ON DELETE SET NULL
);

CREATE TABLE fg_scan_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fgUnitId TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  deptCode TEXT NOT NULL,
  workerId TEXT,
  workerName TEXT,
  picSlot INTEGER,
  action TEXT CHECK (action IN ('COMPLETE','UNDO','SIGN','DISPATCH')),
  sourceBatchId TEXT,
  sourcePieceIndex INTEGER,
  sourceSlotIndex INTEGER,
  note TEXT,
  FOREIGN KEY (fgUnitId) REFERENCES fg_units(id) ON DELETE CASCADE
);

-- --- FIFO cost layers --------------------------------------------------------
CREATE TABLE rm_batches (
  id TEXT PRIMARY KEY,
  rmId TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('OPENING','GRN','ADJUSTMENT')),
  sourceRefId TEXT,
  receivedDate TEXT NOT NULL,
  originalQty REAL NOT NULL,
  remainingQty REAL NOT NULL,
  unitCostSen INTEGER NOT NULL,
  created_at TEXT,
  notes TEXT,
  FOREIGN KEY (rmId) REFERENCES raw_materials(id) ON DELETE CASCADE
);

CREATE TABLE fg_batches (
  id TEXT PRIMARY KEY,
  productId TEXT NOT NULL,
  productionOrderId TEXT,
  completedDate TEXT NOT NULL,
  originalQty INTEGER NOT NULL,
  remainingQty INTEGER NOT NULL,
  unitCostSen INTEGER NOT NULL,
  materialCostSen INTEGER NOT NULL DEFAULT 0,
  laborCostSen INTEGER NOT NULL DEFAULT 0,
  overheadCostSen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  FOREIGN KEY (productId) REFERENCES products(id),
  FOREIGN KEY (productionOrderId) REFERENCES production_orders(id)
);

CREATE TABLE cost_ledger (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('RM_RECEIPT','RM_ISSUE','LABOR_POSTED','FG_COMPLETED','FG_DELIVERED','ADJUSTMENT')),
  itemType TEXT NOT NULL CHECK (itemType IN ('RM','WIP','FG')),
  itemId TEXT NOT NULL,
  batchId TEXT,
  qty REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  unitCostSen INTEGER NOT NULL,
  totalCostSen INTEGER NOT NULL,
  refType TEXT,
  refId TEXT,
  notes TEXT
);

-- --- Rack locations & stock movements ---------------------------------------
CREATE TABLE rack_locations (
  id TEXT PRIMARY KEY,
  rack TEXT NOT NULL,
  position TEXT,
  status TEXT NOT NULL CHECK (status IN ('OCCUPIED','EMPTY','RESERVED')),
  reserved INTEGER,
  productionOrderId TEXT,
  productCode TEXT,
  productName TEXT,
  sizeLabel TEXT,
  customerName TEXT,
  stockedInDate TEXT,
  notes TEXT
);

CREATE TABLE rack_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rackLocationId TEXT NOT NULL,
  productionOrderId TEXT,
  productCode TEXT,
  productName TEXT,
  sizeLabel TEXT,
  customerName TEXT,
  qty INTEGER,
  stockedInDate TEXT,
  notes TEXT,
  FOREIGN KEY (rackLocationId) REFERENCES rack_locations(id) ON DELETE CASCADE
);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('STOCK_IN','STOCK_OUT','TRANSFER')),
  rackLocationId TEXT,
  rackLabel TEXT,
  productionOrderId TEXT,
  productCode TEXT,
  productName TEXT,
  quantity INTEGER NOT NULL,
  reason TEXT,
  performedBy TEXT,
  created_at TEXT NOT NULL
);

-- --- GRNs / 3-way match ------------------------------------------------------
CREATE TABLE grns (
  id TEXT PRIMARY KEY,
  grnNumber TEXT NOT NULL,
  poId TEXT,
  poNumber TEXT,
  supplierId TEXT,
  supplierName TEXT,
  receiveDate TEXT,
  receivedBy TEXT,
  totalAmount INTEGER NOT NULL DEFAULT 0,
  qcStatus TEXT CHECK (qcStatus IN ('PENDING','PASSED','PARTIAL','FAILED')),
  status TEXT CHECK (status IN ('DRAFT','CONFIRMED','POSTED')),
  notes TEXT,
  FOREIGN KEY (poId) REFERENCES purchase_orders(id),
  FOREIGN KEY (supplierId) REFERENCES suppliers(id)
);

CREATE TABLE grn_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grnId TEXT NOT NULL,
  poItemIndex INTEGER,
  materialCode TEXT,
  materialName TEXT,
  orderedQty REAL NOT NULL DEFAULT 0,
  receivedQty REAL NOT NULL DEFAULT 0,
  acceptedQty REAL NOT NULL DEFAULT 0,
  rejectedQty REAL NOT NULL DEFAULT 0,
  rejectionReason TEXT,
  unitPrice INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (grnId) REFERENCES grns(id) ON DELETE CASCADE
);

CREATE TABLE three_way_matches (
  id TEXT PRIMARY KEY,
  poId TEXT,
  poNumber TEXT,
  grnId TEXT,
  grnNumber TEXT,
  invoiceId TEXT,
  invoiceNumber TEXT,
  supplierId TEXT,
  supplierName TEXT,
  matchStatus TEXT CHECK (matchStatus IN ('FULL_MATCH','PARTIAL_MATCH','MISMATCH','PENDING_INVOICE')),
  poTotal INTEGER NOT NULL DEFAULT 0,
  grnTotal INTEGER NOT NULL DEFAULT 0,
  invoiceTotal INTEGER,
  variance INTEGER NOT NULL DEFAULT 0,
  variancePercent REAL NOT NULL DEFAULT 0,
  withinTolerance INTEGER NOT NULL DEFAULT 0,
  items TEXT,       -- JSON line items
  FOREIGN KEY (poId) REFERENCES purchase_orders(id),
  FOREIGN KEY (grnId) REFERENCES grns(id),
  FOREIGN KEY (supplierId) REFERENCES suppliers(id)
);

-- --- Goods in transit --------------------------------------------------------
CREATE TABLE goods_in_transit (
  id TEXT PRIMARY KEY,
  poId TEXT,
  poNumber TEXT,
  supplierId TEXT,
  supplierName TEXT,
  shippingMethod TEXT CHECK (shippingMethod IN ('SEA','AIR','LAND','COURIER')),
  containerNumber TEXT,
  trackingNumber TEXT,
  carrierName TEXT,
  status TEXT CHECK (status IN ('ORDERED','SHIPPED','IN_TRANSIT','CUSTOMS','RECEIVED')),
  orderDate TEXT,
  shippedDate TEXT,
  expectedArrival TEXT,
  actualArrival TEXT,
  customsClearanceDate TEXT,
  customsStatus TEXT CHECK (customsStatus IN ('N/A','PENDING','CLEARED','HELD')),
  currency TEXT CHECK (currency IN ('MYR','RMB')),
  productCost REAL NOT NULL DEFAULT 0,
  shippingCost REAL NOT NULL DEFAULT 0,
  customsDuty REAL NOT NULL DEFAULT 0,
  exchangeRate REAL,
  landedCost REAL NOT NULL DEFAULT 0,
  items TEXT,       -- JSON line items
  notes TEXT,
  -- NOTE: poId is intentionally not FK-enforced; goods in transit may
  -- reference external/legacy PO IDs (e.g. "po-ext-*") outside the live set.
  FOREIGN KEY (supplierId) REFERENCES suppliers(id)
);

-- ############################################################################
-- 4. ACCOUNTING — COA, journals, AR/AP aging, bank, cashflow, P&L, BS
-- ############################################################################

CREATE TABLE chart_of_accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  parentCode TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  isActive INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (parentCode) REFERENCES chart_of_accounts(code) ON DELETE SET NULL
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  entryNo TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','POSTED','REVERSED')),
  createdBy TEXT,
  created_at TEXT
);

CREATE TABLE journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journalEntryId TEXT NOT NULL,
  accountCode TEXT NOT NULL,
  accountName TEXT,
  debitSen INTEGER NOT NULL DEFAULT 0,
  creditSen INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  FOREIGN KEY (journalEntryId) REFERENCES journal_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (accountCode) REFERENCES chart_of_accounts(code)
);

CREATE TABLE ar_aging (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customerId TEXT NOT NULL,
  customerName TEXT NOT NULL,
  currentSen INTEGER NOT NULL DEFAULT 0,
  days30Sen INTEGER NOT NULL DEFAULT 0,
  days60Sen INTEGER NOT NULL DEFAULT 0,
  days90Sen INTEGER NOT NULL DEFAULT 0,
  over90Sen INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (customerId) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE ap_aging (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplierId TEXT NOT NULL,
  supplierName TEXT NOT NULL,
  currentSen INTEGER NOT NULL DEFAULT 0,
  days30Sen INTEGER NOT NULL DEFAULT 0,
  days60Sen INTEGER NOT NULL DEFAULT 0,
  days90Sen INTEGER NOT NULL DEFAULT 0,
  over90Sen INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (supplierId) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE bank_accounts (
  id TEXT PRIMARY KEY,
  bankName TEXT NOT NULL,
  accountNo TEXT NOT NULL,
  accountName TEXT NOT NULL,
  balanceSen INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL
);

CREATE TABLE bank_transactions (
  id TEXT PRIMARY KEY,
  bankAccountId TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT,
  amountSen INTEGER NOT NULL DEFAULT 0,
  type TEXT CHECK (type IN ('DEPOSIT','WITHDRAWAL','TRANSFER')),
  reference TEXT,
  isReconciled INTEGER NOT NULL DEFAULT 0,
  matchedJournalId TEXT,
  FOREIGN KEY (bankAccountId) REFERENCES bank_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (matchedJournalId) REFERENCES journal_entries(id) ON DELETE SET NULL
);

CREATE TABLE pl_entries (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  accountCode TEXT NOT NULL,
  accountName TEXT,
  category TEXT CHECK (category IN ('REVENUE','COGS','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')),
  amount INTEGER NOT NULL DEFAULT 0,
  productCategory TEXT CHECK (productCategory IN ('BEDFRAME','SOFA','ACCESSORY','ALL')),
  customerId TEXT,
  customerName TEXT,
  state TEXT
);

CREATE TABLE balance_sheet_entries (
  id TEXT PRIMARY KEY,
  accountCode TEXT NOT NULL,
  accountName TEXT,
  category TEXT CHECK (category IN ('CURRENT_ASSET','FIXED_ASSET','CURRENT_LIABILITY','LONG_TERM_LIABILITY','EQUITY')),
  balance INTEGER NOT NULL DEFAULT 0,
  asOfDate TEXT
);

-- --- Stock value & stock accounts --------------------------------------------
CREATE TABLE stock_accounts (
  code TEXT PRIMARY KEY,
  description TEXT,
  category TEXT CHECK (category IN ('FG','WIP','RAW_MATERIAL'))
);

CREATE TABLE monthly_stock_values (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  accountCode TEXT NOT NULL,
  accountDescription TEXT,
  openingValue INTEGER NOT NULL DEFAULT 0,
  purchasesValue INTEGER NOT NULL DEFAULT 0,
  consumptionValue INTEGER NOT NULL DEFAULT 0,
  closingValue INTEGER NOT NULL DEFAULT 0,
  physicalCountValue INTEGER,
  variancePercent REAL,
  status TEXT CHECK (status IN ('DRAFT','REVIEWED','POSTED')),
  postedDate TEXT,
  postedBy TEXT
);

-- ############################################################################
-- 5. SUPPORTING — attendance, leave, approvals, QC, R&D, maintenance, etc.
-- ############################################################################

-- --- Attendance / Leave / Payroll -------------------------------------------
CREATE TABLE attendance_records (
  id TEXT PRIMARY KEY,
  employeeId TEXT NOT NULL,
  employeeName TEXT,
  departmentCode TEXT,
  departmentName TEXT,
  date TEXT NOT NULL,
  clockIn TEXT,
  clockOut TEXT,
  status TEXT NOT NULL CHECK (status IN ('PRESENT','ABSENT','HALF_DAY','MEDICAL_LEAVE','ANNUAL_LEAVE','REST_DAY')),
  workingMinutes INTEGER NOT NULL DEFAULT 0,
  productionTimeMinutes INTEGER NOT NULL DEFAULT 0,
  efficiencyPct REAL NOT NULL DEFAULT 0,
  overtimeMinutes INTEGER NOT NULL DEFAULT 0,
  deptBreakdown TEXT,  -- JSON [{deptCode, minutes, productCode}]
  notes TEXT,
  FOREIGN KEY (employeeId) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE TABLE leave_records (
  id TEXT PRIMARY KEY,
  workerId TEXT NOT NULL,
  workerName TEXT,
  type TEXT CHECK (type IN ('ANNUAL','MEDICAL','UNPAID','EMERGENCY','PUBLIC_HOLIDAY')),
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  days REAL NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reason TEXT,
  approvedBy TEXT,
  FOREIGN KEY (workerId) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE TABLE payroll_records (
  id TEXT PRIMARY KEY,
  workerId TEXT NOT NULL,
  workerName TEXT,
  period TEXT NOT NULL,
  basicSalarySen INTEGER NOT NULL DEFAULT 0,
  workingDays REAL NOT NULL DEFAULT 0,
  otHoursWeekday REAL NOT NULL DEFAULT 0,
  otHoursSunday REAL NOT NULL DEFAULT 0,
  otHoursHoliday REAL NOT NULL DEFAULT 0,
  otAmountSen INTEGER NOT NULL DEFAULT 0,
  grossSalarySen INTEGER NOT NULL DEFAULT 0,
  epfEmployeeSen INTEGER NOT NULL DEFAULT 0,
  epfEmployerSen INTEGER NOT NULL DEFAULT 0,
  socsoEmployeeSen INTEGER NOT NULL DEFAULT 0,
  socsoEmployerSen INTEGER NOT NULL DEFAULT 0,
  eisEmployeeSen INTEGER NOT NULL DEFAULT 0,
  eisEmployerSen INTEGER NOT NULL DEFAULT 0,
  pcbSen INTEGER NOT NULL DEFAULT 0,
  totalDeductionsSen INTEGER NOT NULL DEFAULT 0,
  netPaySen INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('DRAFT','APPROVED','PAID')),
  FOREIGN KEY (workerId) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE TABLE payslip_details (
  id TEXT PRIMARY KEY,
  employeeId TEXT NOT NULL,
  employeeName TEXT,
  employeeNo TEXT,
  departmentCode TEXT,
  period TEXT NOT NULL,
  basicSalary INTEGER NOT NULL DEFAULT 0,
  workingDays REAL NOT NULL DEFAULT 0,
  otWeekdayHours REAL NOT NULL DEFAULT 0,
  otSundayHours REAL NOT NULL DEFAULT 0,
  otPHHours REAL NOT NULL DEFAULT 0,
  hourlyRate INTEGER NOT NULL DEFAULT 0,
  otWeekdayAmount INTEGER NOT NULL DEFAULT 0,
  otSundayAmount INTEGER NOT NULL DEFAULT 0,
  otPHAmount INTEGER NOT NULL DEFAULT 0,
  totalOT INTEGER NOT NULL DEFAULT 0,
  allowances INTEGER NOT NULL DEFAULT 0,
  grossPay INTEGER NOT NULL DEFAULT 0,
  epfEmployee INTEGER NOT NULL DEFAULT 0,
  epfEmployer INTEGER NOT NULL DEFAULT 0,
  socsoEmployee INTEGER NOT NULL DEFAULT 0,
  socsoEmployer INTEGER NOT NULL DEFAULT 0,
  eisEmployee INTEGER NOT NULL DEFAULT 0,
  eisEmployer INTEGER NOT NULL DEFAULT 0,
  pcb INTEGER NOT NULL DEFAULT 0,
  totalDeductions INTEGER NOT NULL DEFAULT 0,
  netPay INTEGER NOT NULL DEFAULT 0,
  bankAccount TEXT,
  status TEXT CHECK (status IN ('DRAFT','APPROVED','PAID')),
  FOREIGN KEY (employeeId) REFERENCES workers(id) ON DELETE CASCADE
);

-- --- Approval Requests -------------------------------------------------------
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('PRICE_OVERRIDE','DISCOUNT','PO_APPROVAL','LEAVE_REQUEST','STOCK_ADJUSTMENT','CREDIT_OVERRIDE','SO_CANCELLATION')),
  referenceNo TEXT,
  referenceId TEXT,
  title TEXT NOT NULL,
  description TEXT,
  requestedBy TEXT,
  requestedAt TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  approvedBy TEXT,
  approvedAt TEXT,
  reason TEXT,
  amountSen INTEGER,
  metadata TEXT  -- JSON Record<string,string>
);

-- --- QC Inspections / Defects ------------------------------------------------
CREATE TABLE qc_inspections (
  id TEXT PRIMARY KEY,
  inspectionNo TEXT NOT NULL,
  productionOrderId TEXT,
  poNo TEXT,
  productCode TEXT,
  productName TEXT,
  customerName TEXT,
  department TEXT,
  inspectorId TEXT,
  inspectorName TEXT,
  result TEXT CHECK (result IN ('PASS','FAIL','CONDITIONAL_PASS')),
  notes TEXT,
  inspectionDate TEXT,
  created_at TEXT,
  FOREIGN KEY (productionOrderId) REFERENCES production_orders(id) ON DELETE SET NULL
);

CREATE TABLE qc_defects (
  id TEXT PRIMARY KEY,
  qcInspectionId TEXT NOT NULL,
  type TEXT CHECK (type IN ('FABRIC','ALIGNMENT','STRUCTURAL','STAIN','DIMENSION','FINISH','OTHER')),
  severity TEXT CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
  description TEXT,
  actionTaken TEXT CHECK (actionTaken IN ('REWORK','ACCEPT','REJECT','REPAIR')),
  FOREIGN KEY (qcInspectionId) REFERENCES qc_inspections(id) ON DELETE CASCADE
);

-- --- R&D / Prototype tracking -------------------------------------------------
CREATE TABLE rd_projects (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  projectType TEXT CHECK (projectType IN ('DEVELOPMENT','IMPROVEMENT')),
  productCategory TEXT CHECK (productCategory IN ('BEDFRAME','SOFA','ACCESSORY')),
  serviceId TEXT,
  currentStage TEXT CHECK (currentStage IN ('CONCEPT','DESIGN','PROTOTYPE','TESTING','APPROVED','PRODUCTION_READY')),
  targetLaunchDate TEXT,
  assignedTeam TEXT,      -- JSON string[]
  totalBudget INTEGER NOT NULL DEFAULT 0,
  actualCost INTEGER NOT NULL DEFAULT 0,
  milestones TEXT,        -- JSON [{stage, targetDate, actualDate, approvedBy, photos[]}]
  productionBOM TEXT,     -- JSON
  materialIssuances TEXT, -- JSON
  labourLogs TEXT,        -- JSON
  createdDate TEXT,
  status TEXT CHECK (status IN ('ACTIVE','ON_HOLD','COMPLETED','CANCELLED'))
);

CREATE TABLE rd_prototypes (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  prototypeType TEXT CHECK (prototypeType IN ('FABRIC_SEWING','FRAMING')),
  version TEXT NOT NULL,
  description TEXT,
  materialsCost INTEGER NOT NULL DEFAULT 0,
  labourHours REAL NOT NULL DEFAULT 0,
  testResults TEXT,
  feedback TEXT,
  improvements TEXT,
  defects TEXT,
  createdDate TEXT,
  FOREIGN KEY (projectId) REFERENCES rd_projects(id) ON DELETE CASCADE
);

-- --- Equipment / Maintenance --------------------------------------------------
CREATE TABLE equipment_list (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  department TEXT,
  type TEXT CHECK (type IN ('SEWING_MACHINE','CUTTING_TABLE','STAPLE_GUN','COMPRESSOR','SAW','DRILL','OTHER')),
  status TEXT CHECK (status IN ('OPERATIONAL','MAINTENANCE','REPAIR','DECOMMISSIONED')),
  lastMaintenanceDate TEXT,
  nextMaintenanceDate TEXT,
  maintenanceCycleDays INTEGER NOT NULL DEFAULT 0,
  purchaseDate TEXT,
  notes TEXT
);

CREATE TABLE maintenance_logs (
  id TEXT PRIMARY KEY,
  equipmentId TEXT NOT NULL,
  equipmentName TEXT,
  type TEXT CHECK (type IN ('PREVENTIVE','CORRECTIVE','EMERGENCY')),
  description TEXT,
  performedBy TEXT,
  date TEXT,
  costSen INTEGER NOT NULL DEFAULT 0,
  downtimeHours REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (equipmentId) REFERENCES equipment_list(id) ON DELETE CASCADE
);

-- --- Consignment --------------------------------------------------------------
CREATE TABLE consignment_notes (
  id TEXT PRIMARY KEY,
  noteNumber TEXT NOT NULL,
  type TEXT CHECK (type IN ('OUT','RETURN')),
  customerId TEXT NOT NULL,
  customerName TEXT,
  branchName TEXT,
  sentDate TEXT,
  status TEXT CHECK (status IN ('ACTIVE','PARTIALLY_SOLD','FULLY_SOLD','RETURNED','CLOSED')),
  totalValue INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  FOREIGN KEY (customerId) REFERENCES customers(id)
);

CREATE TABLE consignment_items (
  id TEXT PRIMARY KEY,
  consignmentNoteId TEXT NOT NULL,
  productId TEXT,
  productName TEXT,
  productCode TEXT,
  quantity INTEGER NOT NULL,
  unitPrice INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('AT_BRANCH','SOLD','RETURNED','DAMAGED')),
  soldDate TEXT,
  returnedDate TEXT,
  FOREIGN KEY (consignmentNoteId) REFERENCES consignment_notes(id) ON DELETE CASCADE
);

-- --- Notifications ------------------------------------------------------------
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  type TEXT CHECK (type IN ('ORDER','PRODUCTION','INVENTORY','DELIVERY','QUALITY','FINANCE','SYSTEM')),
  title TEXT NOT NULL,
  message TEXT,
  severity TEXT CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  isRead INTEGER NOT NULL DEFAULT 0,
  link TEXT,
  created_at TEXT NOT NULL
);

-- --- MRP ---------------------------------------------------------------------
CREATE TABLE mrp_runs (
  id TEXT PRIMARY KEY,
  runDate TEXT NOT NULL,
  planningHorizon TEXT,
  productionOrderCount INTEGER NOT NULL DEFAULT 0,
  totalMaterials INTEGER NOT NULL DEFAULT 0,
  shortageCount INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('COMPLETED','IN_PROGRESS'))
);

CREATE TABLE mrp_requirements (
  id TEXT PRIMARY KEY,
  mrpRunId TEXT NOT NULL,
  materialName TEXT,
  materialCategory TEXT,
  unit TEXT,
  grossRequired REAL NOT NULL DEFAULT 0,
  onHand REAL NOT NULL DEFAULT 0,
  onOrder REAL NOT NULL DEFAULT 0,
  netRequired REAL NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('SUFFICIENT','LOW','SHORTAGE')),
  suggestedPOQty REAL NOT NULL DEFAULT 0,
  preferredSupplierId TEXT,
  preferredSupplierName TEXT,
  FOREIGN KEY (mrpRunId) REFERENCES mrp_runs(id) ON DELETE CASCADE
);

-- --- Forecasting / Historical sales ------------------------------------------
CREATE TABLE historical_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  productId TEXT NOT NULL,
  productCode TEXT,
  productName TEXT,
  period TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  revenue INTEGER NOT NULL DEFAULT 0,
  customerId TEXT,
  customerName TEXT
);

CREATE TABLE forecast_entries (
  id TEXT PRIMARY KEY,
  productId TEXT NOT NULL,
  productName TEXT,
  productCode TEXT,
  period TEXT NOT NULL,
  forecastQty REAL NOT NULL DEFAULT 0,
  actualQty REAL,
  method TEXT CHECK (method IN ('SMA_3','SMA_6','WMA')),
  confidence REAL NOT NULL DEFAULT 0,
  createdDate TEXT
);

CREATE TABLE promise_date_calcs (
  productId TEXT PRIMARY KEY,
  currentQueueDays REAL NOT NULL DEFAULT 0,
  materialAvailability TEXT CHECK (materialAvailability IN ('IN_STOCK','PARTIAL','NEED_ORDER')),
  estimatedCompletionDays REAL NOT NULL DEFAULT 0,
  promiseDate TEXT
);

-- --- Planning / Scheduling ----------------------------------------------------
CREATE TABLE dept_lead_times (
  deptCode TEXT PRIMARY KEY,
  deptName TEXT NOT NULL,
  bedframeDays INTEGER NOT NULL DEFAULT 0,
  sofaDays INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE schedule_entries (
  id TEXT PRIMARY KEY,
  productionOrderId TEXT,
  soNumber TEXT,
  productCode TEXT,
  category TEXT CHECK (category IN ('BEDFRAME','SOFA')),
  customerDeliveryDate TEXT,
  customerName TEXT,
  hookkaExpectedDD TEXT,
  deptSchedule TEXT,  -- JSON [{deptCode, deptName, startDate, endDate, minutes, status}]
  FOREIGN KEY (productionOrderId) REFERENCES production_orders(id) ON DELETE SET NULL
);

-- --- Price override / SO status change log -----------------------------------
CREATE TABLE price_overrides (
  id TEXT PRIMARY KEY,
  soId TEXT,
  soNumber TEXT,
  lineIndex INTEGER NOT NULL DEFAULT 0,
  originalPrice INTEGER NOT NULL DEFAULT 0,
  overridePrice INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  approvedBy TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (soId) REFERENCES sales_orders(id) ON DELETE SET NULL
);

CREATE TABLE so_status_changes (
  id TEXT PRIMARY KEY,
  soId TEXT,
  fromStatus TEXT,
  toStatus TEXT,
  changedBy TEXT,
  timestamp TEXT NOT NULL,
  notes TEXT,
  autoActions TEXT,  -- JSON string[]
  FOREIGN KEY (soId) REFERENCES sales_orders(id) ON DELETE SET NULL
);

-- --- BOM Templates / Versions -------------------------------------------------
CREATE TABLE bom_templates (
  id TEXT PRIMARY KEY,
  productCode TEXT NOT NULL,
  baseModel TEXT,
  category TEXT CHECK (category IN ('BEDFRAME','SOFA')),
  l1Processes TEXT,   -- JSON [{dept, deptCode, category, minutes}]
  wipComponents TEXT, -- JSON nested tree
  version TEXT NOT NULL,
  versionStatus TEXT CHECK (versionStatus IN ('DRAFT','ACTIVE','OBSOLETE')),
  effectiveFrom TEXT,
  effectiveTo TEXT,
  changeLog TEXT
);

CREATE TABLE bom_versions (
  id TEXT PRIMARY KEY,
  productId TEXT NOT NULL,
  productCode TEXT,
  version TEXT NOT NULL,
  status TEXT CHECK (status IN ('ACTIVE','DRAFT','OBSOLETE')),
  effectiveFrom TEXT,
  effectiveTo TEXT,
  tree TEXT,          -- JSON BOMNode
  totalMinutes INTEGER NOT NULL DEFAULT 0,
  labourCost INTEGER NOT NULL DEFAULT 0,
  materialCost INTEGER NOT NULL DEFAULT 0,
  totalCost INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
);

-- --- Production lead times (single-row K/V) ----------------------------------
CREATE TABLE production_lead_times (
  category TEXT NOT NULL CHECK (category IN ('BEDFRAME','SOFA')),
  deptCode TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, deptCode)
);

-- --- Inter-company config (singleton) ----------------------------------------
CREATE TABLE inter_company_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hookkaToOhanaRate REAL NOT NULL DEFAULT 0,
  autoCreateMirrorDocs INTEGER NOT NULL DEFAULT 1,
  activeOrgId TEXT
);

-- ############################################################################
-- 6. INDEXES
-- ############################################################################

-- Customers / hubs
CREATE INDEX idx_customers_code ON customers(code);
CREATE INDEX idx_customers_active ON customers(isActive);
CREATE INDEX idx_delivery_hubs_customerId ON delivery_hubs(customerId);
CREATE INDEX idx_customer_hubs_parentId ON customer_hubs(parentId);

-- Products & BOM
CREATE INDEX idx_products_code ON products(code);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_bom_components_productId ON bom_components(productId);
CREATE INDEX idx_material_substitutes_component ON material_substitutes(bomComponentId);
CREATE INDEX idx_dept_working_times_productId ON dept_working_times(productId);

-- Fabrics & raw materials
CREATE INDEX idx_fabrics_code ON fabrics(code);
CREATE INDEX idx_fabric_trackings_code ON fabric_trackings(fabricCode);
CREATE INDEX idx_rm_itemCode ON raw_materials(itemCode);
CREATE INDEX idx_rm_group ON raw_materials(itemGroup);
CREATE INDEX idx_rm_active ON raw_materials(isActive);

-- Workers
CREATE INDEX idx_workers_empNo ON workers(empNo);
CREATE INDEX idx_workers_departmentId ON workers(departmentId);
CREATE INDEX idx_workers_departmentCode ON workers(departmentCode);
CREATE INDEX idx_workers_status ON workers(status);

-- Suppliers
CREATE INDEX idx_suppliers_code ON suppliers(code);
CREATE INDEX idx_suppliers_status ON suppliers(status);
CREATE INDEX idx_supplier_materials_supplierId ON supplier_materials(supplierId);
CREATE INDEX idx_supplier_bindings_supplierId ON supplier_material_bindings(supplierId);
CREATE INDEX idx_price_histories_bindingId ON price_histories(bindingId);

-- Sales orders
CREATE INDEX idx_so_customerId ON sales_orders(customerId);
CREATE INDEX idx_so_hubId ON sales_orders(hubId);
CREATE INDEX idx_so_status ON sales_orders(status);
CREATE INDEX idx_so_customerDeliveryDate ON sales_orders(customerDeliveryDate);
CREATE INDEX idx_so_companySOId ON sales_orders(companySOId);
CREATE INDEX idx_so_customerPOId ON sales_orders(customerPOId);
CREATE INDEX idx_so_items_salesOrderId ON sales_order_items(salesOrderId);
CREATE INDEX idx_so_items_productId ON sales_order_items(productId);

-- Purchase orders
CREATE INDEX idx_po_supplierId ON purchase_orders(supplierId);
CREATE INDEX idx_po_status ON purchase_orders(status);
CREATE INDEX idx_po_orderDate ON purchase_orders(orderDate);
CREATE INDEX idx_po_items_poId ON purchase_order_items(purchaseOrderId);

-- Delivery orders
CREATE INDEX idx_do_customerId ON delivery_orders(customerId);
CREATE INDEX idx_do_salesOrderId ON delivery_orders(salesOrderId);
CREATE INDEX idx_do_status ON delivery_orders(status);
CREATE INDEX idx_do_deliveryDate ON delivery_orders(deliveryDate);
CREATE INDEX idx_do_items_deliveryOrderId ON delivery_order_items(deliveryOrderId);
CREATE INDEX idx_do_items_poId ON delivery_order_items(productionOrderId);

-- Invoices
CREATE INDEX idx_invoices_customerId ON invoices(customerId);
CREATE INDEX idx_invoices_salesOrderId ON invoices(salesOrderId);
CREATE INDEX idx_invoices_deliveryOrderId ON invoices(deliveryOrderId);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_invoiceDate ON invoices(invoiceDate);
CREATE INDEX idx_invoice_items_invoiceId ON invoice_items(invoiceId);
CREATE INDEX idx_invoice_payments_invoiceId ON invoice_payments(invoiceId);

-- Credit/Debit/Payment
CREATE INDEX idx_credit_notes_customerId ON credit_notes(customerId);
CREATE INDEX idx_credit_notes_invoiceId ON credit_notes(invoiceId);
CREATE INDEX idx_debit_notes_customerId ON debit_notes(customerId);
CREATE INDEX idx_debit_notes_invoiceId ON debit_notes(invoiceId);
CREATE INDEX idx_payment_records_customerId ON payment_records(customerId);
CREATE INDEX idx_payment_records_date ON payment_records(date);

-- Production
CREATE INDEX idx_prod_po_salesOrderId ON production_orders(salesOrderId);
CREATE INDEX idx_prod_po_productId ON production_orders(productId);
CREATE INDEX idx_prod_po_status ON production_orders(status);
CREATE INDEX idx_prod_po_currentDepartment ON production_orders(currentDepartment);
CREATE INDEX idx_jc_poId ON job_cards(productionOrderId);
CREATE INDEX idx_jc_departmentId ON job_cards(departmentId);
CREATE INDEX idx_jc_departmentCode ON job_cards(departmentCode);
CREATE INDEX idx_jc_status ON job_cards(status);
CREATE INDEX idx_jc_pic1 ON job_cards(pic1Id);
CREATE INDEX idx_jc_pic2 ON job_cards(pic2Id);
CREATE INDEX idx_piece_pics_jc ON piece_pics(jobCardId);
CREATE INDEX idx_fg_units_poId ON fg_units(poId);
CREATE INDEX idx_fg_units_soId ON fg_units(soId);
CREATE INDEX idx_fg_units_doId ON fg_units(doId);
CREATE INDEX idx_fg_units_status ON fg_units(status);
CREATE INDEX idx_fg_scan_history_fg ON fg_scan_history(fgUnitId);

-- FIFO cost layers / ledger
CREATE INDEX idx_rm_batches_rmId ON rm_batches(rmId);
CREATE INDEX idx_rm_batches_receivedDate ON rm_batches(receivedDate);
CREATE INDEX idx_fg_batches_productId ON fg_batches(productId);
CREATE INDEX idx_fg_batches_poId ON fg_batches(productionOrderId);
CREATE INDEX idx_fg_batches_completedDate ON fg_batches(completedDate);
CREATE INDEX idx_cost_ledger_date ON cost_ledger(date);
CREATE INDEX idx_cost_ledger_itemType ON cost_ledger(itemType);
CREATE INDEX idx_cost_ledger_itemId ON cost_ledger(itemId);
CREATE INDEX idx_cost_ledger_type ON cost_ledger(type);

-- Rack / stock movements
CREATE INDEX idx_rack_items_rackId ON rack_items(rackLocationId);
CREATE INDEX idx_stock_movements_type ON stock_movements(type);
CREATE INDEX idx_stock_movements_poId ON stock_movements(productionOrderId);
CREATE INDEX idx_stock_movements_date ON stock_movements(created_at);

-- GRN / 3-way
CREATE INDEX idx_grns_poId ON grns(poId);
CREATE INDEX idx_grns_supplierId ON grns(supplierId);
CREATE INDEX idx_grn_items_grnId ON grn_items(grnId);
CREATE INDEX idx_3wm_poId ON three_way_matches(poId);
CREATE INDEX idx_3wm_grnId ON three_way_matches(grnId);
CREATE INDEX idx_3wm_supplierId ON three_way_matches(supplierId);
CREATE INDEX idx_git_poId ON goods_in_transit(poId);
CREATE INDEX idx_git_supplierId ON goods_in_transit(supplierId);
CREATE INDEX idx_git_status ON goods_in_transit(status);

-- Accounting
CREATE INDEX idx_coa_parent ON chart_of_accounts(parentCode);
CREATE INDEX idx_coa_type ON chart_of_accounts(type);
CREATE INDEX idx_je_date ON journal_entries(date);
CREATE INDEX idx_je_status ON journal_entries(status);
CREATE INDEX idx_jl_jeId ON journal_lines(journalEntryId);
CREATE INDEX idx_jl_accountCode ON journal_lines(accountCode);
CREATE INDEX idx_bt_bankAccountId ON bank_transactions(bankAccountId);
CREATE INDEX idx_bt_date ON bank_transactions(date);
CREATE INDEX idx_pl_period ON pl_entries(period);
CREATE INDEX idx_pl_accountCode ON pl_entries(accountCode);
CREATE INDEX idx_bs_asOfDate ON balance_sheet_entries(asOfDate);
CREATE INDEX idx_msv_period ON monthly_stock_values(period);
CREATE INDEX idx_msv_account ON monthly_stock_values(accountCode);

-- Attendance / Leave / Payroll
CREATE INDEX idx_attendance_employeeId ON attendance_records(employeeId);
CREATE INDEX idx_attendance_date ON attendance_records(date);
CREATE INDEX idx_attendance_status ON attendance_records(status);
CREATE INDEX idx_leave_workerId ON leave_records(workerId);
CREATE INDEX idx_leave_status ON leave_records(status);
CREATE INDEX idx_leave_startDate ON leave_records(startDate);
CREATE INDEX idx_payroll_workerId ON payroll_records(workerId);
CREATE INDEX idx_payroll_period ON payroll_records(period);
CREATE INDEX idx_payslip_employeeId ON payslip_details(employeeId);
CREATE INDEX idx_payslip_period ON payslip_details(period);

-- Approvals
CREATE INDEX idx_approval_type ON approval_requests(type);
CREATE INDEX idx_approval_status ON approval_requests(status);
CREATE INDEX idx_approval_referenceId ON approval_requests(referenceId);

-- QC
CREATE INDEX idx_qc_poId ON qc_inspections(productionOrderId);
CREATE INDEX idx_qc_result ON qc_inspections(result);
CREATE INDEX idx_qc_date ON qc_inspections(inspectionDate);
CREATE INDEX idx_qc_defects_insp ON qc_defects(qcInspectionId);

-- R&D
CREATE INDEX idx_rd_status ON rd_projects(status);
CREATE INDEX idx_rd_stage ON rd_projects(currentStage);
CREATE INDEX idx_rd_prototypes_projectId ON rd_prototypes(projectId);

-- Equipment / Maintenance
CREATE INDEX idx_equipment_status ON equipment_list(status);
CREATE INDEX idx_equipment_department ON equipment_list(department);
CREATE INDEX idx_maintenance_equipmentId ON maintenance_logs(equipmentId);
CREATE INDEX idx_maintenance_date ON maintenance_logs(date);

-- Consignment
CREATE INDEX idx_consignment_customerId ON consignment_notes(customerId);
CREATE INDEX idx_consignment_status ON consignment_notes(status);
CREATE INDEX idx_consignment_items_noteId ON consignment_items(consignmentNoteId);
CREATE INDEX idx_consignment_items_status ON consignment_items(status);

-- Notifications
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_isRead ON notifications(isRead);

-- MRP
CREATE INDEX idx_mrp_runs_runDate ON mrp_runs(runDate);
CREATE INDEX idx_mrp_requirements_runId ON mrp_requirements(mrpRunId);
CREATE INDEX idx_mrp_requirements_status ON mrp_requirements(status);

-- Forecasting
CREATE INDEX idx_historical_sales_productId ON historical_sales(productId);
CREATE INDEX idx_historical_sales_period ON historical_sales(period);
CREATE INDEX idx_forecast_productId ON forecast_entries(productId);
CREATE INDEX idx_forecast_period ON forecast_entries(period);

-- Scheduling
CREATE INDEX idx_schedule_entries_poId ON schedule_entries(productionOrderId);
CREATE INDEX idx_schedule_entries_category ON schedule_entries(category);

-- BOM
CREATE INDEX idx_bom_templates_productCode ON bom_templates(productCode);
CREATE INDEX idx_bom_templates_version ON bom_templates(version);
CREATE INDEX idx_bom_templates_status ON bom_templates(versionStatus);
CREATE INDEX idx_bom_versions_productId ON bom_versions(productId);
CREATE INDEX idx_bom_versions_status ON bom_versions(status);

-- E-Invoices
CREATE INDEX idx_einvoices_invoiceId ON e_invoices(invoiceId);
CREATE INDEX idx_einvoices_status ON e_invoices(status);

-- Price overrides / SO status changes
CREATE INDEX idx_price_overrides_soId ON price_overrides(soId);
CREATE INDEX idx_so_status_changes_soId ON so_status_changes(soId);
