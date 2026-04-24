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
  short_name TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  color TEXT NOT NULL,
  working_hours_per_day INTEGER NOT NULL
);

-- --- Customers --------------------------------------------------------------
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  ssm_no TEXT,
  company_address TEXT,
  credit_terms TEXT,
  credit_limit_sen INTEGER NOT NULL DEFAULT 0,
  outstanding_sen INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  contact_name TEXT,
  phone TEXT,
  email TEXT
);

CREATE TABLE delivery_hubs (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  code TEXT NOT NULL,
  short_name TEXT NOT NULL,
  state TEXT,
  address TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- --- Customer Hubs (hierarchical customer-branch directory) -----------------
CREATE TABLE customer_hubs (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  creditor_code TEXT NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  state TEXT,
  pic TEXT,
  pic_contact TEXT,
  pic_email TEXT,
  delivery_address TEXT,
  is_parent INTEGER NOT NULL DEFAULT 0,
  children TEXT,  -- JSON string[]
  FOREIGN KEY (parent_id) REFERENCES customer_hubs(id) ON DELETE SET NULL
);

-- --- Products ---------------------------------------------------------------
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('SOFA','BEDFRAME','ACCESSORY')),
  description TEXT,
  base_model TEXT,
  size_code TEXT,
  size_label TEXT,
  fabric_usage DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit_m3 DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  cost_price_sen INTEGER NOT NULL DEFAULT 0,
  base_price_sen INTEGER,
  price1_sen INTEGER,
  production_time_minutes INTEGER NOT NULL DEFAULT 0,
  sub_assemblies TEXT,  -- JSON string[]
  sku_code TEXT,
  fabric_color TEXT,
  pieces TEXT,          -- JSON { count, names[] }
  seat_height_prices TEXT -- JSON [{height, priceSen}]
);

CREATE TABLE bom_components (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  material_category TEXT NOT NULL,
  material_name TEXT NOT NULL,
  qty_per_unit DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  waste_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE material_substitutes (
  id BIGSERIAL PRIMARY KEY,
  bom_component_id TEXT,       -- nullable: also used by BOMTemplateWIP
  bom_template_wip_id TEXT,     -- nullable
  material_id TEXT,
  material_name TEXT NOT NULL,
  material_category TEXT,
  cost_diff_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  FOREIGN KEY (bom_component_id) REFERENCES bom_components(id) ON DELETE CASCADE
);

CREATE TABLE dept_working_times (
  id BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  department_code TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  category TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- --- Product Dept Configs (GSheet per-product working time defaults) --------
CREATE TABLE product_dept_configs (
  product_code TEXT PRIMARY KEY,
  unit_m3 DOUBLE PRECISION NOT NULL DEFAULT 0,
  fabric_usage DOUBLE PRECISION NOT NULL DEFAULT 0,
  price2_sen INTEGER NOT NULL DEFAULT 0,
  fab_cut_category TEXT,
  fab_cut_minutes INTEGER,
  fab_sew_category TEXT,
  fab_sew_minutes INTEGER,
  wood_cut_category TEXT,
  wood_cut_minutes INTEGER,
  foam_category TEXT,
  foam_minutes INTEGER,
  framing_category TEXT,
  framing_minutes INTEGER,
  upholstery_category TEXT,
  upholstery_minutes INTEGER,
  packing_category TEXT,
  packing_minutes INTEGER,
  sub_assemblies TEXT,         -- JSON string[]
  heights_sub_assemblies TEXT   -- JSON string[]
);

-- --- Fabrics ----------------------------------------------------------------
CREATE TABLE fabrics (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  price_sen INTEGER NOT NULL DEFAULT 0,
  soh_meters DOUBLE PRECISION NOT NULL DEFAULT 0,
  reorder_level DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- --- Fabric Tracking (richer analytics view) --------------------------------
CREATE TABLE fabric_trackings (
  id TEXT PRIMARY KEY,
  fabric_code TEXT NOT NULL,
  fabric_description TEXT,
  fabric_category TEXT CHECK (fabric_category IN ('B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING')),
  price_tier TEXT CHECK (price_tier IN ('PRICE_1','PRICE_2')),
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  soh DOUBLE PRECISION NOT NULL DEFAULT 0,
  po_outstanding DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_month_usage DOUBLE PRECISION NOT NULL DEFAULT 0,
  one_week_usage DOUBLE PRECISION NOT NULL DEFAULT 0,
  two_weeks_usage DOUBLE PRECISION NOT NULL DEFAULT 0,
  one_month_usage DOUBLE PRECISION NOT NULL DEFAULT 0,
  shortage DOUBLE PRECISION NOT NULL DEFAULT 0,
  reorder_point DOUBLE PRECISION NOT NULL DEFAULT 0,
  supplier TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 0
);

-- --- Raw Materials ----------------------------------------------------------
CREATE TABLE raw_materials (
  id TEXT PRIMARY KEY,
  item_code TEXT NOT NULL,
  description TEXT NOT NULL,
  base_uom TEXT NOT NULL,
  item_group TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  balance_qty DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- --- Workers / Employees ----------------------------------------------------
CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  emp_no TEXT NOT NULL,
  name TEXT NOT NULL,
  department_id TEXT,
  department_code TEXT,
  position TEXT,
  phone TEXT,
  status TEXT NOT NULL,
  basic_salary_sen INTEGER NOT NULL DEFAULT 0,
  working_hours_per_day INTEGER NOT NULL DEFAULT 9,
  working_days_per_month INTEGER NOT NULL DEFAULT 26,
  join_date TEXT,
  ic_number TEXT,
  passport_number TEXT,
  nationality TEXT,
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
);

-- --- Worker portal auth (PIN + opaque bearer tokens) ------------------------
-- PIN stored plaintext because this is a shop-floor convenience login, not
-- real auth. Replace with bcrypt when worker portal hits real auth.
CREATE TABLE worker_pins (
  worker_id TEXT PRIMARY KEY,
  pin TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE TABLE worker_tokens (
  token TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE INDEX idx_worker_tokens_worker_id ON worker_tokens(worker_id);

-- --- Suppliers --------------------------------------------------------------
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  state TEXT,
  payment_terms TEXT,
  status TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE supplier_materials (
  id BIGSERIAL PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  material_category TEXT NOT NULL,
  supplier_sku TEXT NOT NULL,
  unit_price_sen INTEGER NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  min_order_qty INTEGER NOT NULL DEFAULT 0,
  priority TEXT CHECK (priority IN ('A','B','C')),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_material_bindings (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  material_code TEXT NOT NULL,
  material_name TEXT NOT NULL,
  supplier_sku TEXT NOT NULL,
  unit_price INTEGER NOT NULL DEFAULT 0,
  currency TEXT CHECK (currency IN ('MYR','RMB')),
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  payment_terms TEXT,
  moq INTEGER NOT NULL DEFAULT 0,
  price_valid_from TEXT,
  price_valid_to TEXT,
  is_main_supplier INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE price_histories (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  material_code TEXT NOT NULL,
  old_price INTEGER NOT NULL DEFAULT 0,
  new_price INTEGER NOT NULL DEFAULT 0,
  currency TEXT CHECK (currency IN ('MYR','RMB')),
  changed_date TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  reason TEXT,
  approval_status TEXT CHECK (approval_status IN ('APPROVED','PENDING','REJECTED')),
  FOREIGN KEY (binding_id) REFERENCES supplier_material_bindings(id) ON DELETE CASCADE,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE supplier_scorecards (
  supplier_id TEXT PRIMARY KEY,
  on_time_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  quality_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  lead_time_accuracy DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_price_trend DOUBLE PRECISION NOT NULL DEFAULT 0,
  overall_rating DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_updated TEXT,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

-- --- Organisations ----------------------------------------------------------
CREATE TABLE organisations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK (code IN ('HOOKKA','OHANA')),
  name TEXT NOT NULL,
  reg_no TEXT,
  tin TEXT,
  msic TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  transfer_pricing_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
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
  plate_number TEXT,
  capacity DOUBLE PRECISION NOT NULL DEFAULT 0,
  driver_name TEXT,
  driver_contact TEXT,
  status TEXT CHECK (status IN ('AVAILABLE','IN_USE','MAINTENANCE'))
);

CREATE TABLE three_pl_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  contact_person TEXT,
  vehicle_no TEXT,
  vehicle_type TEXT,
  capacity_m3 DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate_per_trip_sen INTEGER NOT NULL DEFAULT 0,
  rate_per_extra_drop_sen INTEGER NOT NULL DEFAULT 0,
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
  customer_po TEXT,
  customer_po_id TEXT,
  customer_po_date TEXT,
  customer_so TEXT,
  customer_so_id TEXT,
  reference TEXT,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_state TEXT,
  hub_id TEXT,
  hub_name TEXT,
  company_so TEXT,
  company_so_id TEXT,
  company_so_date TEXT,
  customer_delivery_date TEXT,
  hookka_expected_dd TEXT,
  hookka_delivery_order TEXT,
  subtotal_sen INTEGER NOT NULL DEFAULT 0,
  total_sen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','IN_PRODUCTION','READY_TO_SHIP','SHIPPED','DELIVERED','INVOICED','CLOSED','ON_HOLD','CANCELLED')),
  overdue TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (hub_id) REFERENCES delivery_hubs(id) ON DELETE SET NULL
);

CREATE TABLE sales_order_items (
  id TEXT PRIMARY KEY,
  sales_order_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  line_suffix TEXT,
  product_id TEXT,
  product_code TEXT,
  product_name TEXT,
  item_category TEXT CHECK (item_category IN ('SOFA','BEDFRAME','ACCESSORY')),
  size_code TEXT,
  size_label TEXT,
  fabric_id TEXT,
  fabric_code TEXT,
  quantity INTEGER NOT NULL,
  gap_inches INTEGER,
  divan_height_inches INTEGER,
  divan_price_sen INTEGER NOT NULL DEFAULT 0,
  leg_height_inches INTEGER,
  leg_price_sen INTEGER NOT NULL DEFAULT 0,
  special_order TEXT,
  special_order_price_sen INTEGER NOT NULL DEFAULT 0,
  base_price_sen INTEGER NOT NULL DEFAULT 0,
  unit_price_sen INTEGER NOT NULL DEFAULT 0,
  line_total_sen INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  -- NOTE: productId is a variant code (e.g. "prod-1003-A---K-") that is
  -- dynamically generated from size/fabric/config combinations. It is
  -- intentionally not enforced against the products catalog.
  FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE
);

-- --- Purchase Orders --------------------------------------------------------
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  po_no TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  supplier_name TEXT,
  subtotal_sen INTEGER NOT NULL DEFAULT 0,
  total_sen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  order_date TEXT,
  expected_date TEXT,
  received_date TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE purchase_order_items (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL,
  material_category TEXT,
  material_name TEXT,
  supplier_sku TEXT,
  quantity DOUBLE PRECISION NOT NULL,
  unit_price_sen INTEGER NOT NULL DEFAULT 0,
  total_sen INTEGER NOT NULL DEFAULT 0,
  received_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit TEXT,
  FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
);

-- --- Delivery Orders --------------------------------------------------------
CREATE TABLE delivery_orders (
  id TEXT PRIMARY KEY,
  do_no TEXT NOT NULL,
  sales_order_id TEXT,
  company_so TEXT,
  company_so_id TEXT,
  customer_id TEXT NOT NULL,
  customer_po_id TEXT,
  customer_name TEXT NOT NULL,
  customer_state TEXT,
  hub_id TEXT,
  hub_name TEXT,
  delivery_address TEXT,
  contact_person TEXT,
  contact_phone TEXT,
  delivery_date TEXT,
  hookka_expected_dd TEXT,
  driver_id TEXT,
  driver_name TEXT,
  vehicle_no TEXT,
  total_m3 DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','LOADED','DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED','CANCELLED')),
  overdue TEXT,
  dispatched_at TEXT,
  delivered_at TEXT,
  remarks TEXT,
  drop_points INTEGER,
  delivery_cost_sen INTEGER,
  lorry_id TEXT,
  lorry_name TEXT,
  do_qr_code TEXT,
  fg_unit_ids TEXT,             -- JSON string[]
  signed_at TEXT,
  signed_by_worker_id TEXT,
  signed_by_worker_name TEXT,
  proof_of_delivery TEXT,       -- JSON ProofOfDelivery
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (hub_id) REFERENCES delivery_hubs(id) ON DELETE SET NULL
);

CREATE TABLE delivery_order_items (
  id TEXT PRIMARY KEY,
  delivery_order_id TEXT NOT NULL,
  production_order_id TEXT,
  po_no TEXT,
  product_code TEXT,
  product_name TEXT,
  size_label TEXT,
  fabric_code TEXT,
  quantity INTEGER NOT NULL,
  item_m3 DOUBLE PRECISION NOT NULL DEFAULT 0,
  racking_number TEXT,
  packing_status TEXT,
  sales_order_no TEXT,
  FOREIGN KEY (delivery_order_id) REFERENCES delivery_orders(id) ON DELETE CASCADE
);

-- --- Invoices ---------------------------------------------------------------
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  invoice_no TEXT NOT NULL,
  delivery_order_id TEXT,
  do_no TEXT,
  sales_order_id TEXT,
  company_so_id TEXT,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_state TEXT,
  hub_id TEXT,
  hub_name TEXT,
  subtotal_sen INTEGER NOT NULL DEFAULT 0,
  total_sen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  invoice_date TEXT,
  due_date TEXT,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  payment_date TEXT,
  payment_method TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
  FOREIGN KEY (delivery_order_id) REFERENCES delivery_orders(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (hub_id) REFERENCES delivery_hubs(id) ON DELETE SET NULL
);

CREATE TABLE invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  product_code TEXT,
  product_name TEXT,
  size_label TEXT,
  fabric_code TEXT,
  quantity INTEGER NOT NULL,
  unit_price_sen INTEGER NOT NULL DEFAULT 0,
  total_sen INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

CREATE TABLE invoice_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount_sen INTEGER NOT NULL DEFAULT 0,
  method TEXT CHECK (method IN ('CASH','CHEQUE','BANK_TRANSFER','CREDIT_CARD','E_WALLET')),
  reference TEXT,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

-- --- Credit Notes, Debit Notes, Payment Records -----------------------------
CREATE TABLE credit_notes (
  id TEXT PRIMARY KEY,
  note_number TEXT NOT NULL,
  invoice_id TEXT,
  invoice_number TEXT,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT CHECK (reason IN ('RETURN','PRICE_ADJUSTMENT','DAMAGE','OVERCHARGE','OTHER')),
  reason_detail TEXT,
  total_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('DRAFT','APPROVED','POSTED')),
  approved_by TEXT,
  items TEXT,     -- JSON [{description, quantity, unitPrice, total}]
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE debit_notes (
  id TEXT PRIMARY KEY,
  note_number TEXT NOT NULL,
  invoice_id TEXT,
  invoice_number TEXT,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT CHECK (reason IN ('UNDERCHARGE','ADDITIONAL_CHARGE','PRICE_ADJUSTMENT','OTHER')),
  reason_detail TEXT,
  total_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('DRAFT','APPROVED','POSTED')),
  approved_by TEXT,
  items TEXT,     -- JSON
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE payment_records (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT CHECK (method IN ('BANK_TRANSFER','CHEQUE','CASH','CREDIT_CARD')),
  reference TEXT,
  status TEXT CHECK (status IN ('RECEIVED','CLEARED','BOUNCED')),
  allocations TEXT,  -- JSON [{invoiceId, invoiceNumber, amount}]
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- --- E-Invoices (MyInvois submissions) --------------------------------------
CREATE TABLE e_invoices (
  id TEXT PRIMARY KEY,
  invoice_id TEXT,
  invoice_no TEXT NOT NULL,
  customer_name TEXT,
  customer_tin TEXT,
  submission_id TEXT,
  uuid TEXT,
  status TEXT CHECK (status IN ('PENDING','SUBMITTED','VALID','INVALID','CANCELLED')),
  submitted_at TEXT,
  validated_at TEXT,
  error_message TEXT,
  xml_content TEXT,
  total_excluding_tax INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total_including_tax INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
  -- NOTE: invoiceId is intentionally not FK-enforced; legacy / standalone
  -- e-invoices may reference invoices outside the live set (or be empty).
);

-- ############################################################################
-- 3. PRODUCTION — production orders, job cards, piece pics, WIP, FG, batches
-- ############################################################################

CREATE TABLE production_orders (
  id TEXT PRIMARY KEY,
  po_no TEXT NOT NULL,
  sales_order_id TEXT,
  sales_order_no TEXT,
  line_no INTEGER NOT NULL,
  customer_po_id TEXT,
  customer_reference TEXT,
  customer_name TEXT,
  customer_state TEXT,
  company_so_id TEXT,
  product_id TEXT,
  product_code TEXT,
  product_name TEXT,
  item_category TEXT CHECK (item_category IN ('SOFA','BEDFRAME','ACCESSORY')),
  size_code TEXT,
  size_label TEXT,
  fabric_code TEXT,
  quantity INTEGER NOT NULL,
  gap_inches INTEGER,
  divan_height_inches INTEGER,
  leg_height_inches INTEGER,
  special_order TEXT,
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','ON_HOLD','CANCELLED','PAUSED')),
  current_department TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  target_end_date TEXT,
  completed_date TEXT,
  racking_number TEXT,
  stocked_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE job_cards (
  id TEXT PRIMARY KEY,
  production_order_id TEXT NOT NULL,
  department_id TEXT,
  department_code TEXT,
  department_name TEXT,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WAITING','IN_PROGRESS','PAUSED','COMPLETED','TRANSFERRED','BLOCKED')),
  due_date TEXT,
  wip_key TEXT,
  wip_code TEXT,
  wip_type TEXT,
  wip_label TEXT,
  wip_qty INTEGER,
  prerequisite_met INTEGER NOT NULL DEFAULT 0,
  pic1_id TEXT,
  pic1_name TEXT,
  pic2_id TEXT,
  pic2_name TEXT,
  completed_date TEXT,
  est_minutes INTEGER NOT NULL DEFAULT 0,
  actual_minutes INTEGER,
  category TEXT,
  production_time_minutes INTEGER NOT NULL DEFAULT 0,
  overdue TEXT,
  racking_number TEXT,
  FOREIGN KEY (production_order_id) REFERENCES production_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE piece_pics (
  id BIGSERIAL PRIMARY KEY,
  job_card_id TEXT NOT NULL,
  piece_no INTEGER NOT NULL,
  pic1_id TEXT,
  pic1_name TEXT,
  pic2_id TEXT,
  pic2_name TEXT,
  completed_at TEXT,
  last_scan_at TEXT,
  bound_sticker_key TEXT,
  FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE CASCADE
);

-- --- WIP inventory & FG units ------------------------------------------------
CREATE TABLE wip_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  related_product TEXT,
  dept_status TEXT,
  stock_qty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);

CREATE TABLE fg_units (
  id TEXT PRIMARY KEY,
  unit_serial TEXT NOT NULL,
  short_code TEXT,
  so_id TEXT,
  so_no TEXT,
  so_line_no INTEGER,
  po_id TEXT,
  po_no TEXT,
  product_code TEXT,
  product_name TEXT,
  unit_no INTEGER,
  total_units INTEGER,
  piece_no INTEGER,
  total_pieces INTEGER,
  piece_name TEXT,
  customer_name TEXT,
  customer_hub TEXT,
  mfd_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PENDING_UPHOLSTERY','UPHOLSTERED','PACKED','LOADED','DELIVERED','RETURNED')),
  packer_id TEXT,
  packer_name TEXT,
  packed_at TEXT,
  loaded_at TEXT,
  delivered_at TEXT,
  returned_at TEXT,
  batch_id TEXT,
  source_piece_index INTEGER,
  source_slot_index INTEGER,
  upholstered_by TEXT,
  upholstered_by_name TEXT,
  upholstered_at TEXT,
  do_id TEXT,
  FOREIGN KEY (so_id) REFERENCES sales_orders(id),
  FOREIGN KEY (po_id) REFERENCES production_orders(id),
  FOREIGN KEY (do_id) REFERENCES delivery_orders(id) ON DELETE SET NULL
);

CREATE TABLE fg_scan_history (
  id BIGSERIAL PRIMARY KEY,
  fg_unit_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  dept_code TEXT NOT NULL,
  worker_id TEXT,
  worker_name TEXT,
  pic_slot INTEGER,
  action TEXT CHECK (action IN ('COMPLETE','UNDO','SIGN','DISPATCH')),
  source_batch_id TEXT,
  source_piece_index INTEGER,
  source_slot_index INTEGER,
  note TEXT,
  FOREIGN KEY (fg_unit_id) REFERENCES fg_units(id) ON DELETE CASCADE
);

-- --- FIFO cost layers --------------------------------------------------------
CREATE TABLE rm_batches (
  id TEXT PRIMARY KEY,
  rm_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('OPENING','GRN','ADJUSTMENT')),
  source_ref_id TEXT,
  received_date TEXT NOT NULL,
  original_qty DOUBLE PRECISION NOT NULL,
  remaining_qty DOUBLE PRECISION NOT NULL,
  unit_cost_sen INTEGER NOT NULL,
  created_at TEXT,
  notes TEXT,
  FOREIGN KEY (rm_id) REFERENCES raw_materials(id) ON DELETE CASCADE
);

CREATE TABLE fg_batches (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  production_order_id TEXT,
  completed_date TEXT NOT NULL,
  original_qty INTEGER NOT NULL,
  remaining_qty INTEGER NOT NULL,
  unit_cost_sen INTEGER NOT NULL,
  material_cost_sen INTEGER NOT NULL DEFAULT 0,
  labor_cost_sen INTEGER NOT NULL DEFAULT 0,
  overhead_cost_sen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (production_order_id) REFERENCES production_orders(id)
);

CREATE TABLE cost_ledger (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('RM_RECEIPT','RM_ISSUE','LABOR_POSTED','FG_COMPLETED','FG_DELIVERED','ADJUSTMENT')),
  item_type TEXT NOT NULL CHECK (item_type IN ('RM','WIP','FG')),
  item_id TEXT NOT NULL,
  batch_id TEXT,
  qty DOUBLE PRECISION NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  unit_cost_sen INTEGER NOT NULL,
  total_cost_sen INTEGER NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  notes TEXT
);

-- --- Rack locations & stock movements ---------------------------------------
CREATE TABLE rack_locations (
  id TEXT PRIMARY KEY,
  rack TEXT NOT NULL,
  position TEXT,
  status TEXT NOT NULL CHECK (status IN ('OCCUPIED','EMPTY','RESERVED')),
  reserved INTEGER,
  production_order_id TEXT,
  product_code TEXT,
  product_name TEXT,
  size_label TEXT,
  customer_name TEXT,
  stocked_in_date TEXT,
  notes TEXT
);

CREATE TABLE rack_items (
  id BIGSERIAL PRIMARY KEY,
  rack_location_id TEXT NOT NULL,
  production_order_id TEXT,
  product_code TEXT,
  product_name TEXT,
  size_label TEXT,
  customer_name TEXT,
  qty INTEGER,
  stocked_in_date TEXT,
  notes TEXT,
  FOREIGN KEY (rack_location_id) REFERENCES rack_locations(id) ON DELETE CASCADE
);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('STOCK_IN','STOCK_OUT','TRANSFER')),
  rack_location_id TEXT,
  rack_label TEXT,
  production_order_id TEXT,
  product_code TEXT,
  product_name TEXT,
  quantity INTEGER NOT NULL,
  reason TEXT,
  performed_by TEXT,
  created_at TEXT NOT NULL
);

-- --- GRNs / 3-way match ------------------------------------------------------
CREATE TABLE grns (
  id TEXT PRIMARY KEY,
  grn_number TEXT NOT NULL,
  po_id TEXT,
  po_number TEXT,
  supplier_id TEXT,
  supplier_name TEXT,
  receive_date TEXT,
  received_by TEXT,
  total_amount INTEGER NOT NULL DEFAULT 0,
  qc_status TEXT CHECK (qc_status IN ('PENDING','PASSED','PARTIAL','FAILED')),
  status TEXT CHECK (status IN ('DRAFT','CONFIRMED','POSTED')),
  notes TEXT,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE grn_items (
  id BIGSERIAL PRIMARY KEY,
  grn_id TEXT NOT NULL,
  po_item_index INTEGER,
  material_code TEXT,
  material_name TEXT,
  ordered_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  received_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  accepted_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  rejected_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  unit_price INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (grn_id) REFERENCES grns(id) ON DELETE CASCADE
);

CREATE TABLE three_way_matches (
  id TEXT PRIMARY KEY,
  po_id TEXT,
  po_number TEXT,
  grn_id TEXT,
  grn_number TEXT,
  invoice_id TEXT,
  invoice_number TEXT,
  supplier_id TEXT,
  supplier_name TEXT,
  match_status TEXT CHECK (match_status IN ('FULL_MATCH','PARTIAL_MATCH','MISMATCH','PENDING_INVOICE')),
  po_total INTEGER NOT NULL DEFAULT 0,
  grn_total INTEGER NOT NULL DEFAULT 0,
  invoice_total INTEGER,
  variance INTEGER NOT NULL DEFAULT 0,
  variance_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  within_tolerance INTEGER NOT NULL DEFAULT 0,
  items TEXT,       -- JSON line items
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (grn_id) REFERENCES grns(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

-- --- Goods in transit --------------------------------------------------------
CREATE TABLE goods_in_transit (
  id TEXT PRIMARY KEY,
  po_id TEXT,
  po_number TEXT,
  supplier_id TEXT,
  supplier_name TEXT,
  shipping_method TEXT CHECK (shipping_method IN ('SEA','AIR','LAND','COURIER')),
  container_number TEXT,
  tracking_number TEXT,
  carrier_name TEXT,
  status TEXT CHECK (status IN ('ORDERED','SHIPPED','IN_TRANSIT','CUSTOMS','RECEIVED')),
  order_date TEXT,
  shipped_date TEXT,
  expected_arrival TEXT,
  actual_arrival TEXT,
  customs_clearance_date TEXT,
  customs_status TEXT CHECK (customs_status IN ('N/A','PENDING','CLEARED','HELD')),
  currency TEXT CHECK (currency IN ('MYR','RMB')),
  product_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  shipping_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  customs_duty DOUBLE PRECISION NOT NULL DEFAULT 0,
  exchange_rate DOUBLE PRECISION,
  landed_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  items TEXT,       -- JSON line items
  notes TEXT,
  -- NOTE: poId is intentionally not FK-enforced; goods in transit may
  -- reference external/legacy PO IDs (e.g. "po-ext-*") outside the live set.
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

-- ############################################################################
-- 4. ACCOUNTING — COA, journals, AR/AP aging, bank, cashflow, P&L, BS
-- ############################################################################

CREATE TABLE chart_of_accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  parent_code TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (parent_code) REFERENCES chart_of_accounts(code) ON DELETE SET NULL
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  entry_no TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','POSTED','REVERSED')),
  created_by TEXT,
  created_at TEXT
);

CREATE TABLE journal_lines (
  id BIGSERIAL PRIMARY KEY,
  journal_entry_id TEXT NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT,
  debit_sen INTEGER NOT NULL DEFAULT 0,
  credit_sen INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (account_code) REFERENCES chart_of_accounts(code)
);

CREATE TABLE ar_aging (
  id BIGSERIAL PRIMARY KEY,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  current_sen INTEGER NOT NULL DEFAULT 0,
  days30_sen INTEGER NOT NULL DEFAULT 0,
  days60_sen INTEGER NOT NULL DEFAULT 0,
  days90_sen INTEGER NOT NULL DEFAULT 0,
  over90_sen INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE ap_aging (
  id BIGSERIAL PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  current_sen INTEGER NOT NULL DEFAULT 0,
  days30_sen INTEGER NOT NULL DEFAULT 0,
  days60_sen INTEGER NOT NULL DEFAULT 0,
  days90_sen INTEGER NOT NULL DEFAULT 0,
  over90_sen INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE bank_accounts (
  id TEXT PRIMARY KEY,
  bank_name TEXT NOT NULL,
  account_no TEXT NOT NULL,
  account_name TEXT NOT NULL,
  balance_sen INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL
);

CREATE TABLE bank_transactions (
  id TEXT PRIMARY KEY,
  bank_account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT,
  amount_sen INTEGER NOT NULL DEFAULT 0,
  type TEXT CHECK (type IN ('DEPOSIT','WITHDRAWAL','TRANSFER')),
  reference TEXT,
  is_reconciled INTEGER NOT NULL DEFAULT 0,
  matched_journal_id TEXT,
  FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (matched_journal_id) REFERENCES journal_entries(id) ON DELETE SET NULL
);

CREATE TABLE pl_entries (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT,
  category TEXT CHECK (category IN ('REVENUE','COGS','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')),
  amount INTEGER NOT NULL DEFAULT 0,
  product_category TEXT CHECK (product_category IN ('BEDFRAME','SOFA','ACCESSORY','ALL')),
  customer_id TEXT,
  customer_name TEXT,
  state TEXT
);

CREATE TABLE balance_sheet_entries (
  id TEXT PRIMARY KEY,
  account_code TEXT NOT NULL,
  account_name TEXT,
  category TEXT CHECK (category IN ('CURRENT_ASSET','FIXED_ASSET','CURRENT_LIABILITY','LONG_TERM_LIABILITY','EQUITY')),
  balance INTEGER NOT NULL DEFAULT 0,
  as_of_date TEXT
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
  account_code TEXT NOT NULL,
  account_description TEXT,
  opening_value INTEGER NOT NULL DEFAULT 0,
  purchases_value INTEGER NOT NULL DEFAULT 0,
  consumption_value INTEGER NOT NULL DEFAULT 0,
  closing_value INTEGER NOT NULL DEFAULT 0,
  physical_count_value INTEGER,
  variance_percent DOUBLE PRECISION,
  status TEXT CHECK (status IN ('DRAFT','REVIEWED','POSTED')),
  posted_date TEXT,
  posted_by TEXT
);

-- ############################################################################
-- 5. SUPPORTING — attendance, leave, approvals, QC, R&D, maintenance, etc.
-- ############################################################################

-- --- Attendance / Leave / Payroll -------------------------------------------
CREATE TABLE attendance_records (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  employee_name TEXT,
  department_code TEXT,
  department_name TEXT,
  date TEXT NOT NULL,
  clock_in TEXT,
  clock_out TEXT,
  status TEXT NOT NULL CHECK (status IN ('PRESENT','ABSENT','HALF_DAY','MEDICAL_LEAVE','ANNUAL_LEAVE','REST_DAY')),
  working_minutes INTEGER NOT NULL DEFAULT 0,
  production_time_minutes INTEGER NOT NULL DEFAULT 0,
  efficiency_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  dept_breakdown TEXT,  -- JSON [{deptCode, minutes, productCode}]
  notes TEXT,
  FOREIGN KEY (employee_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE TABLE leave_records (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  worker_name TEXT,
  type TEXT CHECK (type IN ('ANNUAL','MEDICAL','UNPAID','EMERGENCY','PUBLIC_HOLIDAY')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reason TEXT,
  approved_by TEXT,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE TABLE payroll_records (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  worker_name TEXT,
  period TEXT NOT NULL,
  basic_salary_sen INTEGER NOT NULL DEFAULT 0,
  working_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  ot_hours_weekday DOUBLE PRECISION NOT NULL DEFAULT 0,
  ot_hours_sunday DOUBLE PRECISION NOT NULL DEFAULT 0,
  ot_hours_holiday DOUBLE PRECISION NOT NULL DEFAULT 0,
  ot_amount_sen INTEGER NOT NULL DEFAULT 0,
  gross_salary_sen INTEGER NOT NULL DEFAULT 0,
  epf_employee_sen INTEGER NOT NULL DEFAULT 0,
  epf_employer_sen INTEGER NOT NULL DEFAULT 0,
  socso_employee_sen INTEGER NOT NULL DEFAULT 0,
  socso_employer_sen INTEGER NOT NULL DEFAULT 0,
  eis_employee_sen INTEGER NOT NULL DEFAULT 0,
  eis_employer_sen INTEGER NOT NULL DEFAULT 0,
  pcb_sen INTEGER NOT NULL DEFAULT 0,
  total_deductions_sen INTEGER NOT NULL DEFAULT 0,
  net_pay_sen INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('DRAFT','APPROVED','PAID')),
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE TABLE payslip_details (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  employee_name TEXT,
  employee_no TEXT,
  department_code TEXT,
  period TEXT NOT NULL,
  basic_salary INTEGER NOT NULL DEFAULT 0,
  working_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  ot_weekday_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  ot_sunday_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  ot_ph_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  hourly_rate INTEGER NOT NULL DEFAULT 0,
  ot_weekday_amount INTEGER NOT NULL DEFAULT 0,
  ot_sunday_amount INTEGER NOT NULL DEFAULT 0,
  ot_ph_amount INTEGER NOT NULL DEFAULT 0,
  total_ot INTEGER NOT NULL DEFAULT 0,
  allowances INTEGER NOT NULL DEFAULT 0,
  gross_pay INTEGER NOT NULL DEFAULT 0,
  epf_employee INTEGER NOT NULL DEFAULT 0,
  epf_employer INTEGER NOT NULL DEFAULT 0,
  socso_employee INTEGER NOT NULL DEFAULT 0,
  socso_employer INTEGER NOT NULL DEFAULT 0,
  eis_employee INTEGER NOT NULL DEFAULT 0,
  eis_employer INTEGER NOT NULL DEFAULT 0,
  pcb INTEGER NOT NULL DEFAULT 0,
  total_deductions INTEGER NOT NULL DEFAULT 0,
  net_pay INTEGER NOT NULL DEFAULT 0,
  bank_account TEXT,
  status TEXT CHECK (status IN ('DRAFT','APPROVED','PAID')),
  FOREIGN KEY (employee_id) REFERENCES workers(id) ON DELETE CASCADE
);

-- --- Approval Requests -------------------------------------------------------
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('PRICE_OVERRIDE','DISCOUNT','PO_APPROVAL','LEAVE_REQUEST','STOCK_ADJUSTMENT','CREDIT_OVERRIDE','SO_CANCELLATION')),
  reference_no TEXT,
  reference_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  requested_by TEXT,
  requested_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  approved_by TEXT,
  approved_at TEXT,
  reason TEXT,
  amount_sen INTEGER,
  metadata TEXT  -- JSON Record<string,string>
);

-- --- QC Inspections / Defects ------------------------------------------------
CREATE TABLE qc_inspections (
  id TEXT PRIMARY KEY,
  inspection_no TEXT NOT NULL,
  production_order_id TEXT,
  po_no TEXT,
  product_code TEXT,
  product_name TEXT,
  customer_name TEXT,
  department TEXT,
  inspector_id TEXT,
  inspector_name TEXT,
  result TEXT CHECK (result IN ('PASS','FAIL','CONDITIONAL_PASS')),
  notes TEXT,
  inspection_date TEXT,
  created_at TEXT,
  FOREIGN KEY (production_order_id) REFERENCES production_orders(id) ON DELETE SET NULL
);

CREATE TABLE qc_defects (
  id TEXT PRIMARY KEY,
  qc_inspection_id TEXT NOT NULL,
  type TEXT CHECK (type IN ('FABRIC','ALIGNMENT','STRUCTURAL','STAIN','DIMENSION','FINISH','OTHER')),
  severity TEXT CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
  description TEXT,
  action_taken TEXT CHECK (action_taken IN ('REWORK','ACCEPT','REJECT','REPAIR')),
  FOREIGN KEY (qc_inspection_id) REFERENCES qc_inspections(id) ON DELETE CASCADE
);

-- --- R&D / Prototype tracking -------------------------------------------------
CREATE TABLE rd_projects (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  project_type TEXT CHECK (project_type IN ('DEVELOPMENT','IMPROVEMENT')),
  product_category TEXT CHECK (product_category IN ('BEDFRAME','SOFA','ACCESSORY')),
  service_id TEXT,
  current_stage TEXT CHECK (current_stage IN ('CONCEPT','DESIGN','PROTOTYPE','TESTING','APPROVED','PRODUCTION_READY')),
  target_launch_date TEXT,
  assigned_team TEXT,      -- JSON string[]
  total_budget INTEGER NOT NULL DEFAULT 0,
  actual_cost INTEGER NOT NULL DEFAULT 0,
  milestones TEXT,        -- JSON [{stage, targetDate, actualDate, approvedBy, photos[]}]
  production_bom TEXT,     -- JSON
  material_issuances TEXT, -- JSON
  labour_logs TEXT,        -- JSON
  created_date TEXT,
  status TEXT CHECK (status IN ('ACTIVE','ON_HOLD','COMPLETED','CANCELLED'))
);

CREATE TABLE rd_prototypes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  prototype_type TEXT CHECK (prototype_type IN ('FABRIC_SEWING','FRAMING')),
  version TEXT NOT NULL,
  description TEXT,
  materials_cost INTEGER NOT NULL DEFAULT 0,
  labour_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  test_results TEXT,
  feedback TEXT,
  improvements TEXT,
  defects TEXT,
  created_date TEXT,
  FOREIGN KEY (project_id) REFERENCES rd_projects(id) ON DELETE CASCADE
);

-- --- Equipment / Maintenance --------------------------------------------------
CREATE TABLE equipment_list (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  department TEXT,
  type TEXT CHECK (type IN ('SEWING_MACHINE','CUTTING_TABLE','STAPLE_GUN','COMPRESSOR','SAW','DRILL','OTHER')),
  status TEXT CHECK (status IN ('OPERATIONAL','MAINTENANCE','REPAIR','DECOMMISSIONED')),
  last_maintenance_date TEXT,
  next_maintenance_date TEXT,
  maintenance_cycle_days INTEGER NOT NULL DEFAULT 0,
  purchase_date TEXT,
  notes TEXT
);

CREATE TABLE maintenance_logs (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL,
  equipment_name TEXT,
  type TEXT CHECK (type IN ('PREVENTIVE','CORRECTIVE','EMERGENCY')),
  description TEXT,
  performed_by TEXT,
  date TEXT,
  cost_sen INTEGER NOT NULL DEFAULT 0,
  downtime_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  FOREIGN KEY (equipment_id) REFERENCES equipment_list(id) ON DELETE CASCADE
);

-- --- Consignment --------------------------------------------------------------
CREATE TABLE consignment_notes (
  id TEXT PRIMARY KEY,
  note_number TEXT NOT NULL,
  type TEXT CHECK (type IN ('OUT','RETURN')),
  customer_id TEXT NOT NULL,
  customer_name TEXT,
  branch_name TEXT,
  sent_date TEXT,
  status TEXT CHECK (status IN ('ACTIVE','PARTIALLY_SOLD','FULLY_SOLD','RETURNED','CLOSED')),
  total_value INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE consignment_items (
  id TEXT PRIMARY KEY,
  consignment_note_id TEXT NOT NULL,
  product_id TEXT,
  product_name TEXT,
  product_code TEXT,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('AT_BRANCH','SOLD','RETURNED','DAMAGED')),
  sold_date TEXT,
  returned_date TEXT,
  FOREIGN KEY (consignment_note_id) REFERENCES consignment_notes(id) ON DELETE CASCADE
);

-- --- Notifications ------------------------------------------------------------
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  type TEXT CHECK (type IN ('ORDER','PRODUCTION','INVENTORY','DELIVERY','QUALITY','FINANCE','SYSTEM')),
  title TEXT NOT NULL,
  message TEXT,
  severity TEXT CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  is_read INTEGER NOT NULL DEFAULT 0,
  link TEXT,
  created_at TEXT NOT NULL
);

-- --- MRP ---------------------------------------------------------------------
CREATE TABLE mrp_runs (
  id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  planning_horizon TEXT,
  production_order_count INTEGER NOT NULL DEFAULT 0,
  total_materials INTEGER NOT NULL DEFAULT 0,
  shortage_count INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('COMPLETED','IN_PROGRESS'))
);

CREATE TABLE mrp_requirements (
  id TEXT PRIMARY KEY,
  mrp_run_id TEXT NOT NULL,
  material_name TEXT,
  material_category TEXT,
  unit TEXT,
  gross_required DOUBLE PRECISION NOT NULL DEFAULT 0,
  on_hand DOUBLE PRECISION NOT NULL DEFAULT 0,
  on_order DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_required DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('SUFFICIENT','LOW','SHORTAGE')),
  suggested_po_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  preferred_supplier_id TEXT,
  preferred_supplier_name TEXT,
  FOREIGN KEY (mrp_run_id) REFERENCES mrp_runs(id) ON DELETE CASCADE
);

-- --- Forecasting / Historical sales ------------------------------------------
CREATE TABLE historical_sales (
  id BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  product_code TEXT,
  product_name TEXT,
  period TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  revenue INTEGER NOT NULL DEFAULT 0,
  customer_id TEXT,
  customer_name TEXT
);

CREATE TABLE forecast_entries (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  product_name TEXT,
  product_code TEXT,
  period TEXT NOT NULL,
  forecast_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  actual_qty DOUBLE PRECISION,
  method TEXT CHECK (method IN ('SMA_3','SMA_6','WMA')),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_date TEXT
);

CREATE TABLE promise_date_calcs (
  product_id TEXT PRIMARY KEY,
  current_queue_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  material_availability TEXT CHECK (material_availability IN ('IN_STOCK','PARTIAL','NEED_ORDER')),
  estimated_completion_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  promise_date TEXT
);

-- --- Planning / Scheduling ----------------------------------------------------
CREATE TABLE dept_lead_times (
  dept_code TEXT PRIMARY KEY,
  dept_name TEXT NOT NULL,
  bedframe_days INTEGER NOT NULL DEFAULT 0,
  sofa_days INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE schedule_entries (
  id TEXT PRIMARY KEY,
  production_order_id TEXT,
  so_number TEXT,
  product_code TEXT,
  category TEXT CHECK (category IN ('BEDFRAME','SOFA')),
  customer_delivery_date TEXT,
  customer_name TEXT,
  hookka_expected_dd TEXT,
  dept_schedule TEXT,  -- JSON [{deptCode, deptName, startDate, endDate, minutes, status}]
  FOREIGN KEY (production_order_id) REFERENCES production_orders(id) ON DELETE SET NULL
);

-- --- Price override / SO status change log -----------------------------------
CREATE TABLE price_overrides (
  id TEXT PRIMARY KEY,
  so_id TEXT,
  so_number TEXT,
  line_index INTEGER NOT NULL DEFAULT 0,
  original_price INTEGER NOT NULL DEFAULT 0,
  override_price INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  approved_by TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (so_id) REFERENCES sales_orders(id) ON DELETE SET NULL
);

CREATE TABLE so_status_changes (
  id TEXT PRIMARY KEY,
  so_id TEXT,
  from_status TEXT,
  to_status TEXT,
  changed_by TEXT,
  timestamp TEXT NOT NULL,
  notes TEXT,
  auto_actions TEXT,  -- JSON string[]
  FOREIGN KEY (so_id) REFERENCES sales_orders(id) ON DELETE SET NULL
);

-- --- BOM Templates / Versions -------------------------------------------------
CREATE TABLE bom_templates (
  id TEXT PRIMARY KEY,
  product_code TEXT NOT NULL,
  base_model TEXT,
  category TEXT CHECK (category IN ('BEDFRAME','SOFA')),
  l1_processes TEXT,   -- JSON [{dept, deptCode, category, minutes}]
  wip_components TEXT, -- JSON nested tree
  version TEXT NOT NULL,
  version_status TEXT CHECK (version_status IN ('DRAFT','ACTIVE','OBSOLETE')),
  effective_from TEXT,
  effective_to TEXT,
  change_log TEXT
);

CREATE TABLE bom_versions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  product_code TEXT,
  version TEXT NOT NULL,
  status TEXT CHECK (status IN ('ACTIVE','DRAFT','OBSOLETE')),
  effective_from TEXT,
  effective_to TEXT,
  tree TEXT,          -- JSON BOMNode
  total_minutes INTEGER NOT NULL DEFAULT 0,
  labour_cost INTEGER NOT NULL DEFAULT 0,
  material_cost INTEGER NOT NULL DEFAULT 0,
  total_cost INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- --- Production lead times (single-row K/V) ----------------------------------
CREATE TABLE production_lead_times (
  category TEXT NOT NULL CHECK (category IN ('BEDFRAME','SOFA')),
  dept_code TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, dept_code)
);

-- --- Inter-company config (singleton) ----------------------------------------
CREATE TABLE inter_company_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hookka_to_ohana_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  auto_create_mirror_docs INTEGER NOT NULL DEFAULT 1,
  active_org_id TEXT
);

-- ############################################################################
-- 6. INDEXES
-- ############################################################################

-- Customers / hubs
CREATE INDEX idx_customers_code ON customers(code);
CREATE INDEX idx_customers_active ON customers(is_active);
CREATE INDEX idx_delivery_hubs_customer_id ON delivery_hubs(customer_id);
CREATE INDEX idx_customer_hubs_parent_id ON customer_hubs(parent_id);

-- Products & BOM
CREATE INDEX idx_products_code ON products(code);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_bom_components_product_id ON bom_components(product_id);
CREATE INDEX idx_material_substitutes_component ON material_substitutes(bom_component_id);
CREATE INDEX idx_dept_working_times_product_id ON dept_working_times(product_id);

-- Fabrics & raw materials
CREATE INDEX idx_fabrics_code ON fabrics(code);
CREATE INDEX idx_fabric_trackings_code ON fabric_trackings(fabric_code);
CREATE INDEX idx_rm_item_code ON raw_materials(item_code);
CREATE INDEX idx_rm_group ON raw_materials(item_group);
CREATE INDEX idx_rm_active ON raw_materials(is_active);

-- Workers
CREATE INDEX idx_workers_emp_no ON workers(emp_no);
CREATE INDEX idx_workers_department_id ON workers(department_id);
CREATE INDEX idx_workers_department_code ON workers(department_code);
CREATE INDEX idx_workers_status ON workers(status);

-- Suppliers
CREATE INDEX idx_suppliers_code ON suppliers(code);
CREATE INDEX idx_suppliers_status ON suppliers(status);
CREATE INDEX idx_supplier_materials_supplier_id ON supplier_materials(supplier_id);
CREATE INDEX idx_supplier_bindings_supplier_id ON supplier_material_bindings(supplier_id);
CREATE INDEX idx_price_histories_binding_id ON price_histories(binding_id);

-- Sales orders
CREATE INDEX idx_so_customer_id ON sales_orders(customer_id);
CREATE INDEX idx_so_hub_id ON sales_orders(hub_id);
CREATE INDEX idx_so_status ON sales_orders(status);
CREATE INDEX idx_so_customer_delivery_date ON sales_orders(customer_delivery_date);
CREATE INDEX idx_so_company_so_id ON sales_orders(company_so_id);
CREATE INDEX idx_so_customer_po_id ON sales_orders(customer_po_id);
CREATE INDEX idx_so_items_sales_order_id ON sales_order_items(sales_order_id);
CREATE INDEX idx_so_items_product_id ON sales_order_items(product_id);

-- Purchase orders
CREATE INDEX idx_po_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX idx_po_status ON purchase_orders(status);
CREATE INDEX idx_po_order_date ON purchase_orders(order_date);
CREATE INDEX idx_po_items_po_id ON purchase_order_items(purchase_order_id);

-- Delivery orders
CREATE INDEX idx_do_customer_id ON delivery_orders(customer_id);
CREATE INDEX idx_do_sales_order_id ON delivery_orders(sales_order_id);
CREATE INDEX idx_do_status ON delivery_orders(status);
CREATE INDEX idx_do_delivery_date ON delivery_orders(delivery_date);
CREATE INDEX idx_do_items_delivery_order_id ON delivery_order_items(delivery_order_id);
CREATE INDEX idx_do_items_po_id ON delivery_order_items(production_order_id);

-- Invoices
CREATE INDEX idx_invoices_customer_id ON invoices(customer_id);
CREATE INDEX idx_invoices_sales_order_id ON invoices(sales_order_id);
CREATE INDEX idx_invoices_delivery_order_id ON invoices(delivery_order_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_invoice_date ON invoices(invoice_date);
CREATE INDEX idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_payments_invoice_id ON invoice_payments(invoice_id);

-- Credit/Debit/Payment
CREATE INDEX idx_credit_notes_customer_id ON credit_notes(customer_id);
CREATE INDEX idx_credit_notes_invoice_id ON credit_notes(invoice_id);
CREATE INDEX idx_debit_notes_customer_id ON debit_notes(customer_id);
CREATE INDEX idx_debit_notes_invoice_id ON debit_notes(invoice_id);
CREATE INDEX idx_payment_records_customer_id ON payment_records(customer_id);
CREATE INDEX idx_payment_records_date ON payment_records(date);

-- Production
CREATE INDEX idx_prod_po_sales_order_id ON production_orders(sales_order_id);
CREATE INDEX idx_prod_po_product_id ON production_orders(product_id);
CREATE INDEX idx_prod_po_status ON production_orders(status);
CREATE INDEX idx_prod_po_current_department ON production_orders(current_department);
CREATE INDEX idx_jc_po_id ON job_cards(production_order_id);
CREATE INDEX idx_jc_department_id ON job_cards(department_id);
CREATE INDEX idx_jc_department_code ON job_cards(department_code);
CREATE INDEX idx_jc_status ON job_cards(status);
CREATE INDEX idx_jc_pic1 ON job_cards(pic1_id);
CREATE INDEX idx_jc_pic2 ON job_cards(pic2_id);
CREATE INDEX idx_piece_pics_jc ON piece_pics(job_card_id);
CREATE INDEX idx_fg_units_po_id ON fg_units(po_id);
CREATE INDEX idx_fg_units_so_id ON fg_units(so_id);
CREATE INDEX idx_fg_units_do_id ON fg_units(do_id);
CREATE INDEX idx_fg_units_status ON fg_units(status);
CREATE INDEX idx_fg_scan_history_fg ON fg_scan_history(fg_unit_id);

-- FIFO cost layers / ledger
CREATE INDEX idx_rm_batches_rm_id ON rm_batches(rm_id);
CREATE INDEX idx_rm_batches_received_date ON rm_batches(received_date);
CREATE INDEX idx_fg_batches_product_id ON fg_batches(product_id);
CREATE INDEX idx_fg_batches_po_id ON fg_batches(production_order_id);
CREATE INDEX idx_fg_batches_completed_date ON fg_batches(completed_date);
CREATE INDEX idx_cost_ledger_date ON cost_ledger(date);
CREATE INDEX idx_cost_ledger_item_type ON cost_ledger(item_type);
CREATE INDEX idx_cost_ledger_item_id ON cost_ledger(item_id);
CREATE INDEX idx_cost_ledger_type ON cost_ledger(type);

-- Rack / stock movements
CREATE INDEX idx_rack_items_rack_id ON rack_items(rack_location_id);
CREATE INDEX idx_stock_movements_type ON stock_movements(type);
CREATE INDEX idx_stock_movements_po_id ON stock_movements(production_order_id);
CREATE INDEX idx_stock_movements_date ON stock_movements(created_at);

-- GRN / 3-way
CREATE INDEX idx_grns_po_id ON grns(po_id);
CREATE INDEX idx_grns_supplier_id ON grns(supplier_id);
CREATE INDEX idx_grn_items_grn_id ON grn_items(grn_id);
CREATE INDEX idx_3wm_po_id ON three_way_matches(po_id);
CREATE INDEX idx_3wm_grn_id ON three_way_matches(grn_id);
CREATE INDEX idx_3wm_supplier_id ON three_way_matches(supplier_id);
CREATE INDEX idx_git_po_id ON goods_in_transit(po_id);
CREATE INDEX idx_git_supplier_id ON goods_in_transit(supplier_id);
CREATE INDEX idx_git_status ON goods_in_transit(status);

-- Accounting
CREATE INDEX idx_coa_parent ON chart_of_accounts(parent_code);
CREATE INDEX idx_coa_type ON chart_of_accounts(type);
CREATE INDEX idx_je_date ON journal_entries(date);
CREATE INDEX idx_je_status ON journal_entries(status);
CREATE INDEX idx_jl_je_id ON journal_lines(journal_entry_id);
CREATE INDEX idx_jl_account_code ON journal_lines(account_code);
CREATE INDEX idx_bt_bank_account_id ON bank_transactions(bank_account_id);
CREATE INDEX idx_bt_date ON bank_transactions(date);
CREATE INDEX idx_pl_period ON pl_entries(period);
CREATE INDEX idx_pl_account_code ON pl_entries(account_code);
CREATE INDEX idx_bs_as_of_date ON balance_sheet_entries(as_of_date);
CREATE INDEX idx_msv_period ON monthly_stock_values(period);
CREATE INDEX idx_msv_account ON monthly_stock_values(account_code);

-- Attendance / Leave / Payroll
CREATE INDEX idx_attendance_employee_id ON attendance_records(employee_id);
CREATE INDEX idx_attendance_date ON attendance_records(date);
CREATE INDEX idx_attendance_status ON attendance_records(status);
CREATE INDEX idx_leave_worker_id ON leave_records(worker_id);
CREATE INDEX idx_leave_status ON leave_records(status);
CREATE INDEX idx_leave_start_date ON leave_records(start_date);
CREATE INDEX idx_payroll_worker_id ON payroll_records(worker_id);
CREATE INDEX idx_payroll_period ON payroll_records(period);
CREATE INDEX idx_payslip_employee_id ON payslip_details(employee_id);
CREATE INDEX idx_payslip_period ON payslip_details(period);

-- Approvals
CREATE INDEX idx_approval_type ON approval_requests(type);
CREATE INDEX idx_approval_status ON approval_requests(status);
CREATE INDEX idx_approval_reference_id ON approval_requests(reference_id);

-- QC
CREATE INDEX idx_qc_po_id ON qc_inspections(production_order_id);
CREATE INDEX idx_qc_result ON qc_inspections(result);
CREATE INDEX idx_qc_date ON qc_inspections(inspection_date);
CREATE INDEX idx_qc_defects_insp ON qc_defects(qc_inspection_id);

-- R&D
CREATE INDEX idx_rd_status ON rd_projects(status);
CREATE INDEX idx_rd_stage ON rd_projects(current_stage);
CREATE INDEX idx_rd_prototypes_project_id ON rd_prototypes(project_id);

-- Equipment / Maintenance
CREATE INDEX idx_equipment_status ON equipment_list(status);
CREATE INDEX idx_equipment_department ON equipment_list(department);
CREATE INDEX idx_maintenance_equipment_id ON maintenance_logs(equipment_id);
CREATE INDEX idx_maintenance_date ON maintenance_logs(date);

-- Consignment
CREATE INDEX idx_consignment_customer_id ON consignment_notes(customer_id);
CREATE INDEX idx_consignment_status ON consignment_notes(status);
CREATE INDEX idx_consignment_items_note_id ON consignment_items(consignment_note_id);
CREATE INDEX idx_consignment_items_status ON consignment_items(status);

-- Notifications
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);

-- MRP
CREATE INDEX idx_mrp_runs_run_date ON mrp_runs(run_date);
CREATE INDEX idx_mrp_requirements_run_id ON mrp_requirements(mrp_run_id);
CREATE INDEX idx_mrp_requirements_status ON mrp_requirements(status);

-- Forecasting
CREATE INDEX idx_historical_sales_product_id ON historical_sales(product_id);
CREATE INDEX idx_historical_sales_period ON historical_sales(period);
CREATE INDEX idx_forecast_product_id ON forecast_entries(product_id);
CREATE INDEX idx_forecast_period ON forecast_entries(period);

-- Scheduling
CREATE INDEX idx_schedule_entries_po_id ON schedule_entries(production_order_id);
CREATE INDEX idx_schedule_entries_category ON schedule_entries(category);

-- BOM
CREATE INDEX idx_bom_templates_product_code ON bom_templates(product_code);
CREATE INDEX idx_bom_templates_version ON bom_templates(version);
CREATE INDEX idx_bom_templates_status ON bom_templates(version_status);
CREATE INDEX idx_bom_versions_product_id ON bom_versions(product_id);
CREATE INDEX idx_bom_versions_status ON bom_versions(status);

-- E-Invoices
CREATE INDEX idx_einvoices_invoice_id ON e_invoices(invoice_id);
CREATE INDEX idx_einvoices_status ON e_invoices(status);

-- Price overrides / SO status changes
CREATE INDEX idx_price_overrides_so_id ON price_overrides(so_id);
CREATE INDEX idx_so_status_changes_so_id ON so_status_changes(so_id);
