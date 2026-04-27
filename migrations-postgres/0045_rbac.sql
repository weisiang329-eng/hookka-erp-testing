-- ---------------------------------------------------------------------------
-- 0045_rbac.sql — Phase 3 RBAC foundation (P3.1).
--
-- Replaces the ad-hoc users.role single-column model with a (role, resource,
-- action) matrix. The existing users.role TEXT column is KEPT for backward
-- compat during the rollout — middleware (P3.3) reads from the new tables;
-- until that lands, legacy code still consults users.role.
--
-- D1 specifics:
--   * No SQL-level transaction markers / PRAGMA — D1 manages txns itself.
--   * IF NOT EXISTS on every CREATE so the migration is re-runnable.
--   * REFERENCES clauses kept as documentation; D1 enforcement requires
--     PRAGMA foreign_keys = ON; per connection.
--
-- Style follows 0001_init.sql / 0039_job_card_events.sql:
--   * camelCase column names (roleId, permissionId, createdAt).
--   * Timestamps stored as TEXT (ISO 8601), DEFAULT CURRENT_TIMESTAMP.
--   * Enums / unions as TEXT (CHECK constraints omitted here — resource and
--     action are open-ended; new modules can register without schema churn).
--
-- Closes P3.1 in docs/UPGRADE-CONTROL-BOARD.md.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- 1. SCHEMA
-- ============================================================================

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (resource, action)
);

CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);

-- Add roleId column to users for the new model. Legacy users.role TEXT stays
-- until middleware migration (P3.3) completes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id TEXT REFERENCES roles(id);

-- ============================================================================
-- 2. SEED 8 ROLES
-- ============================================================================

INSERT INTO roles (id, name, description) VALUES
  ('role_super_admin', 'SUPER_ADMIN',  'Full system access ON CONFLICT DO NOTHING; manages users, roles, permissions, audit log'),
  ('role_finance',     'FINANCE',      'Accounting, invoices, payments, e-invoices, credit/debit notes'),
  ('role_procurement', 'PROCUREMENT',  'POs, GRNs, suppliers, supplier scorecards, three-way match'),
  ('role_production',  'PRODUCTION',   'Production orders, job cards, BOM, scheduling, MRP'),
  ('role_warehouse',   'WAREHOUSE',    'Inventory, fabric tracking, FG units, stock movements, racks'),
  ('role_sales',       'SALES',        'Sales orders, customers, delivery orders, consignments'),
  ('role_worker',      'WORKER',       'Worker portal — own attendance, payslips, scan, leave'),
  ('role_read_only',   'READ_ONLY',    'View-only access across all modules; no mutations');

-- ============================================================================
-- 3. SEED PERMISSIONS — (resource, action) for every API resource domain.
--    Permission ID format: perm_{resource_slug}_{action} where resource_slug
--    has hyphens replaced by underscores. Standard actions per resource:
--    read, create, update, delete. Domain-specific actions added inline.
-- ============================================================================

-- --- Sales / customer-facing -------------------------------------------------
INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_sales_orders_read',     'sales-orders', 'read',     'View sales orders'),
  ('perm_sales_orders_create',   'sales-orders', 'create',   'Create sales orders'),
  ('perm_sales_orders_update',   'sales-orders', 'update',   'Edit sales orders'),
  ('perm_sales_orders_delete',   'sales-orders', 'delete',   'Delete sales orders'),
  ('perm_sales_orders_confirm',  'sales-orders', 'confirm',  'Confirm sales orders (lock-in for production)'),

  ('perm_customers_read',        'customers',    'read',     'View customers'),
  ('perm_customers_create',      'customers',    'create',   'Create customers'),
  ('perm_customers_update',      'customers',    'update',   'Edit customers'),
  ('perm_customers_delete',      'customers',    'delete',   'Delete customers'),

  ('perm_customer_hubs_read',    'customer-hubs', 'read',    'View customer hubs / branches'),
  ('perm_customer_hubs_create',  'customer-hubs', 'create',  'Create customer hubs'),
  ('perm_customer_hubs_update',  'customer-hubs', 'update',  'Edit customer hubs'),
  ('perm_customer_hubs_delete',  'customer-hubs', 'delete',  'Delete customer hubs'),

  ('perm_customer_products_read',   'customer-products', 'read',   'View customer-product mappings'),
  ('perm_customer_products_create', 'customer-products', 'create', 'Create customer-product mappings'),
  ('perm_customer_products_update', 'customer-products', 'update', 'Edit customer-product mappings'),
  ('perm_customer_products_delete', 'customer-products', 'delete', 'Delete customer-product mappings'),

  ('perm_delivery_orders_read',   'delivery-orders', 'read',   'View delivery orders'),
  ('perm_delivery_orders_create', 'delivery-orders', 'create', 'Create delivery orders'),
  ('perm_delivery_orders_update', 'delivery-orders', 'update', 'Edit delivery orders'),
  ('perm_delivery_orders_delete', 'delivery-orders', 'delete', 'Delete delivery orders'),

  ('perm_consignments_read',     'consignments', 'read',   'View consignments'),
  ('perm_consignments_create',   'consignments', 'create', 'Create consignments'),
  ('perm_consignments_update',   'consignments', 'update', 'Edit consignments'),
  ('perm_consignments_delete',   'consignments', 'delete', 'Delete consignments'),

  ('perm_consignment_notes_read',   'consignment-notes', 'read',   'View consignment notes'),
  ('perm_consignment_notes_create', 'consignment-notes', 'create', 'Create consignment notes'),
  ('perm_consignment_notes_update', 'consignment-notes', 'update', 'Edit consignment notes'),
  ('perm_consignment_notes_delete', 'consignment-notes', 'delete', 'Delete consignment notes') ON CONFLICT DO NOTHING;

-- --- Finance / accounting ----------------------------------------------------
INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_invoices_read',   'invoices', 'read',   'View invoices'),
  ('perm_invoices_create', 'invoices', 'create', 'Create invoices'),
  ('perm_invoices_update', 'invoices', 'update', 'Edit invoices'),
  ('perm_invoices_delete', 'invoices', 'delete', 'Delete invoices'),
  ('perm_invoices_post',   'invoices', 'post',   'Post invoices to ledger'),
  ('perm_invoices_void',   'invoices', 'void',   'Void posted invoices'),

  ('perm_payments_read',   'payments', 'read',   'View payments'),
  ('perm_payments_create', 'payments', 'create', 'Create payments'),
  ('perm_payments_update', 'payments', 'update', 'Edit payments'),
  ('perm_payments_delete', 'payments', 'delete', 'Delete payments'),

  ('perm_credit_notes_read',   'credit-notes', 'read',   'View credit notes'),
  ('perm_credit_notes_create', 'credit-notes', 'create', 'Create credit notes'),
  ('perm_credit_notes_update', 'credit-notes', 'update', 'Edit credit notes'),
  ('perm_credit_notes_delete', 'credit-notes', 'delete', 'Delete credit notes'),

  ('perm_debit_notes_read',   'debit-notes', 'read',   'View debit notes'),
  ('perm_debit_notes_create', 'debit-notes', 'create', 'Create debit notes'),
  ('perm_debit_notes_update', 'debit-notes', 'update', 'Edit debit notes'),
  ('perm_debit_notes_delete', 'debit-notes', 'delete', 'Delete debit notes'),

  ('perm_e_invoices_read',   'e-invoices', 'read',   'View e-invoices'),
  ('perm_e_invoices_create', 'e-invoices', 'create', 'Create e-invoices (LHDN submission)'),
  ('perm_e_invoices_update', 'e-invoices', 'update', 'Edit e-invoices'),
  ('perm_e_invoices_delete', 'e-invoices', 'delete', 'Delete e-invoices'),

  ('perm_accounting_read',   'accounting', 'read',   'View accounting / GL'),
  ('perm_accounting_create', 'accounting', 'create', 'Create journal entries'),
  ('perm_accounting_update', 'accounting', 'update', 'Edit journal entries'),
  ('perm_accounting_delete', 'accounting', 'delete', 'Delete journal entries'),

  ('perm_cost_ledger_read',   'cost-ledger', 'read',   'View cost ledger'),
  ('perm_cost_ledger_create', 'cost-ledger', 'create', 'Create cost ledger entries'),
  ('perm_cost_ledger_update', 'cost-ledger', 'update', 'Edit cost ledger entries'),
  ('perm_cost_ledger_delete', 'cost-ledger', 'delete', 'Delete cost ledger entries'),

  ('perm_cash_flow_read',   'cash-flow', 'read',   'View cash flow'),
  ('perm_cash_flow_create', 'cash-flow', 'create', 'Create cash flow forecasts'),
  ('perm_cash_flow_update', 'cash-flow', 'update', 'Edit cash flow forecasts'),
  ('perm_cash_flow_delete', 'cash-flow', 'delete', 'Delete cash flow forecasts'),

  ('perm_three_way_match_read',   'three-way-match', 'read',   'View 3-way match'),
  ('perm_three_way_match_create', 'three-way-match', 'create', 'Create 3-way match records'),
  ('perm_three_way_match_update', 'three-way-match', 'update', 'Edit 3-way match records'),
  ('perm_three_way_match_delete', 'three-way-match', 'delete', 'Delete 3-way match records') ON CONFLICT DO NOTHING;

-- --- Procurement -------------------------------------------------------------
INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_purchase_orders_read',     'purchase-orders', 'read',     'View purchase orders'),
  ('perm_purchase_orders_create',   'purchase-orders', 'create',   'Create purchase orders'),
  ('perm_purchase_orders_update',   'purchase-orders', 'update',   'Edit purchase orders'),
  ('perm_purchase_orders_delete',   'purchase-orders', 'delete',   'Delete purchase orders'),
  ('perm_purchase_orders_approve',  'purchase-orders', 'approve',  'Approve purchase orders'),
  ('perm_purchase_orders_receive',  'purchase-orders', 'receive',  'Receive against purchase orders'),

  ('perm_grn_read',   'grn', 'read',   'View goods receipt notes'),
  ('perm_grn_create', 'grn', 'create', 'Create goods receipt notes'),
  ('perm_grn_update', 'grn', 'update', 'Edit goods receipt notes'),
  ('perm_grn_delete', 'grn', 'delete', 'Delete goods receipt notes'),

  ('perm_suppliers_read',   'suppliers', 'read',   'View suppliers'),
  ('perm_suppliers_create', 'suppliers', 'create', 'Create suppliers'),
  ('perm_suppliers_update', 'suppliers', 'update', 'Edit suppliers'),
  ('perm_suppliers_delete', 'suppliers', 'delete', 'Delete suppliers'),

  ('perm_supplier_materials_read',   'supplier-materials', 'read',   'View supplier-material catalog'),
  ('perm_supplier_materials_create', 'supplier-materials', 'create', 'Create supplier-material entries'),
  ('perm_supplier_materials_update', 'supplier-materials', 'update', 'Edit supplier-material entries'),
  ('perm_supplier_materials_delete', 'supplier-materials', 'delete', 'Delete supplier-material entries'),

  ('perm_supplier_scorecards_read',   'supplier-scorecards', 'read',   'View supplier scorecards'),
  ('perm_supplier_scorecards_create', 'supplier-scorecards', 'create', 'Create supplier scorecards'),
  ('perm_supplier_scorecards_update', 'supplier-scorecards', 'update', 'Edit supplier scorecards'),
  ('perm_supplier_scorecards_delete', 'supplier-scorecards', 'delete', 'Delete supplier scorecards'),

  ('perm_goods_in_transit_read',   'goods-in-transit', 'read',   'View goods in transit'),
  ('perm_goods_in_transit_create', 'goods-in-transit', 'create', 'Create goods-in-transit records'),
  ('perm_goods_in_transit_update', 'goods-in-transit', 'update', 'Edit goods-in-transit records'),
  ('perm_goods_in_transit_delete', 'goods-in-transit', 'delete', 'Delete goods-in-transit records'),

  ('perm_price_history_read',   'price-history', 'read',   'View price history'),
  ('perm_price_history_create', 'price-history', 'create', 'Create price history entries'),
  ('perm_price_history_update', 'price-history', 'update', 'Edit price history entries'),
  ('perm_price_history_delete', 'price-history', 'delete', 'Delete price history entries'),

  ('perm_raw_materials_read',   'raw-materials', 'read',   'View raw materials'),
  ('perm_raw_materials_create', 'raw-materials', 'create', 'Create raw materials'),
  ('perm_raw_materials_update', 'raw-materials', 'update', 'Edit raw materials'),
  ('perm_raw_materials_delete', 'raw-materials', 'delete', 'Delete raw materials'),

  ('perm_rm_batches_read',   'rm-batches', 'read',   'View RM batches'),
  ('perm_rm_batches_create', 'rm-batches', 'create', 'Create RM batches'),
  ('perm_rm_batches_update', 'rm-batches', 'update', 'Edit RM batches'),
  ('perm_rm_batches_delete', 'rm-batches', 'delete', 'Delete RM batches') ON CONFLICT DO NOTHING;

-- --- Production --------------------------------------------------------------
INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_production_orders_read',     'production-orders', 'read',     'View production orders'),
  ('perm_production_orders_create',   'production-orders', 'create',   'Create production orders'),
  ('perm_production_orders_update',   'production-orders', 'update',   'Edit production orders'),
  ('perm_production_orders_delete',   'production-orders', 'delete',   'Delete production orders'),
  ('perm_production_orders_start',    'production-orders', 'start',    'Start production orders'),
  ('perm_production_orders_complete', 'production-orders', 'complete', 'Complete production orders'),

  ('perm_job_cards_read',   'job-cards', 'read',   'View job cards'),
  ('perm_job_cards_create', 'job-cards', 'create', 'Create job cards'),
  ('perm_job_cards_update', 'job-cards', 'update', 'Edit job cards'),
  ('perm_job_cards_delete', 'job-cards', 'delete', 'Delete job cards'),

  ('perm_bom_read',   'bom', 'read',   'View BOM'),
  ('perm_bom_create', 'bom', 'create', 'Create BOM entries'),
  ('perm_bom_update', 'bom', 'update', 'Edit BOM entries'),
  ('perm_bom_delete', 'bom', 'delete', 'Delete BOM entries'),

  ('perm_bom_master_templates_read',   'bom-master-templates', 'read',   'View BOM master templates'),
  ('perm_bom_master_templates_create', 'bom-master-templates', 'create', 'Create BOM master templates'),
  ('perm_bom_master_templates_update', 'bom-master-templates', 'update', 'Edit BOM master templates'),
  ('perm_bom_master_templates_delete', 'bom-master-templates', 'delete', 'Delete BOM master templates'),

  ('perm_scheduling_read',   'scheduling', 'read',   'View scheduling'),
  ('perm_scheduling_create', 'scheduling', 'create', 'Create schedules'),
  ('perm_scheduling_update', 'scheduling', 'update', 'Edit schedules'),
  ('perm_scheduling_delete', 'scheduling', 'delete', 'Delete schedules'),

  ('perm_mrp_read',   'mrp', 'read',   'View MRP plans'),
  ('perm_mrp_create', 'mrp', 'create', 'Create MRP runs'),
  ('perm_mrp_update', 'mrp', 'update', 'Edit MRP runs'),
  ('perm_mrp_delete', 'mrp', 'delete', 'Delete MRP runs'),

  ('perm_production_leadtimes_read',   'production-leadtimes', 'read',   'View production lead-times'),
  ('perm_production_leadtimes_create', 'production-leadtimes', 'create', 'Create lead-time entries'),
  ('perm_production_leadtimes_update', 'production-leadtimes', 'update', 'Edit lead-time entries'),
  ('perm_production_leadtimes_delete', 'production-leadtimes', 'delete', 'Delete lead-time entries'),

  ('perm_promise_date_read',   'promise-date', 'read',   'View promise dates'),
  ('perm_promise_date_create', 'promise-date', 'create', 'Compute promise dates'),
  ('perm_promise_date_update', 'promise-date', 'update', 'Edit promise dates'),
  ('perm_promise_date_delete', 'promise-date', 'delete', 'Delete promise dates'),

  ('perm_qc_inspections_read',   'qc-inspections', 'read',   'View QC inspections'),
  ('perm_qc_inspections_create', 'qc-inspections', 'create', 'Create QC inspections'),
  ('perm_qc_inspections_update', 'qc-inspections', 'update', 'Edit QC inspections'),
  ('perm_qc_inspections_delete', 'qc-inspections', 'delete', 'Delete QC inspections'),

  ('perm_rd_projects_read',   'rd-projects', 'read',   'View R&D projects'),
  ('perm_rd_projects_create', 'rd-projects', 'create', 'Create R&D projects'),
  ('perm_rd_projects_update', 'rd-projects', 'update', 'Edit R&D projects'),
  ('perm_rd_projects_delete', 'rd-projects', 'delete', 'Delete R&D projects'),

  ('perm_forecasts_read',   'forecasts', 'read',   'View forecasts'),
  ('perm_forecasts_create', 'forecasts', 'create', 'Create forecasts'),
  ('perm_forecasts_update', 'forecasts', 'update', 'Edit forecasts'),
  ('perm_forecasts_delete', 'forecasts', 'delete', 'Delete forecasts') ON CONFLICT DO NOTHING;

-- --- Warehouse / inventory ---------------------------------------------------
INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_inventory_read',   'inventory', 'read',   'View inventory'),
  ('perm_inventory_create', 'inventory', 'create', 'Create inventory adjustments'),
  ('perm_inventory_update', 'inventory', 'update', 'Edit inventory'),
  ('perm_inventory_delete', 'inventory', 'delete', 'Delete inventory entries'),

  ('perm_warehouse_read',   'warehouse', 'read',   'View warehouse / racks'),
  ('perm_warehouse_create', 'warehouse', 'create', 'Create warehouse entries'),
  ('perm_warehouse_update', 'warehouse', 'update', 'Edit warehouse entries'),
  ('perm_warehouse_delete', 'warehouse', 'delete', 'Delete warehouse entries'),

  ('perm_fabrics_read',   'fabrics', 'read',   'View fabrics'),
  ('perm_fabrics_create', 'fabrics', 'create', 'Create fabrics'),
  ('perm_fabrics_update', 'fabrics', 'update', 'Edit fabrics'),
  ('perm_fabrics_delete', 'fabrics', 'delete', 'Delete fabrics'),

  ('perm_fabric_tracking_read',   'fabric-tracking', 'read',   'View fabric tracking'),
  ('perm_fabric_tracking_create', 'fabric-tracking', 'create', 'Create fabric-tracking records'),
  ('perm_fabric_tracking_update', 'fabric-tracking', 'update', 'Edit fabric-tracking records'),
  ('perm_fabric_tracking_delete', 'fabric-tracking', 'delete', 'Delete fabric-tracking records'),

  ('perm_stock_accounts_read',   'stock-accounts', 'read',   'View stock accounts'),
  ('perm_stock_accounts_create', 'stock-accounts', 'create', 'Create stock account entries'),
  ('perm_stock_accounts_update', 'stock-accounts', 'update', 'Edit stock account entries'),
  ('perm_stock_accounts_delete', 'stock-accounts', 'delete', 'Delete stock account entries'),

  ('perm_stock_value_read',   'stock-value', 'read',   'View stock valuation'),
  ('perm_stock_value_create', 'stock-value', 'create', 'Create stock valuation snapshots'),
  ('perm_stock_value_update', 'stock-value', 'update', 'Edit stock valuation snapshots'),
  ('perm_stock_value_delete', 'stock-value', 'delete', 'Delete stock valuation snapshots'),

  ('perm_stock_movements_read',   'stock-movements', 'read',   'View stock movements'),
  ('perm_stock_movements_create', 'stock-movements', 'create', 'Create stock movements'),
  ('perm_stock_movements_update', 'stock-movements', 'update', 'Edit stock movements'),
  ('perm_stock_movements_delete', 'stock-movements', 'delete', 'Delete stock movements'),

  ('perm_fg_units_read',   'fg-units', 'read',   'View finished-goods units'),
  ('perm_fg_units_create', 'fg-units', 'create', 'Create finished-goods units'),
  ('perm_fg_units_update', 'fg-units', 'update', 'Edit finished-goods units'),
  ('perm_fg_units_delete', 'fg-units', 'delete', 'Delete finished-goods units') ON CONFLICT DO NOTHING;

-- --- HR / workers / general --------------------------------------------------
INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_workers_read',   'workers', 'read',   'View workers'),
  ('perm_workers_create', 'workers', 'create', 'Create worker records'),
  ('perm_workers_update', 'workers', 'update', 'Edit worker records'),
  ('perm_workers_delete', 'workers', 'delete', 'Delete worker records'),

  ('perm_attendance_read',   'attendance', 'read',   'View attendance'),
  ('perm_attendance_create', 'attendance', 'create', 'Create attendance records'),
  ('perm_attendance_update', 'attendance', 'update', 'Edit attendance records'),
  ('perm_attendance_delete', 'attendance', 'delete', 'Delete attendance records'),

  ('perm_payroll_read',   'payroll', 'read',   'View payroll'),
  ('perm_payroll_create', 'payroll', 'create', 'Run payroll'),
  ('perm_payroll_update', 'payroll', 'update', 'Edit payroll runs'),
  ('perm_payroll_delete', 'payroll', 'delete', 'Delete payroll runs'),

  ('perm_payslips_read',   'payslips', 'read',   'View payslips'),
  ('perm_payslips_create', 'payslips', 'create', 'Generate payslips'),
  ('perm_payslips_update', 'payslips', 'update', 'Edit payslips'),
  ('perm_payslips_delete', 'payslips', 'delete', 'Delete payslips'),

  ('perm_leaves_read',   'leaves', 'read',   'View leave applications'),
  ('perm_leaves_create', 'leaves', 'create', 'Create leave applications'),
  ('perm_leaves_update', 'leaves', 'update', 'Approve/edit leave applications'),
  ('perm_leaves_delete', 'leaves', 'delete', 'Delete leave applications'),

  ('perm_products_read',   'products', 'read',   'View products'),
  ('perm_products_create', 'products', 'create', 'Create products'),
  ('perm_products_update', 'products', 'update', 'Edit products'),
  ('perm_products_delete', 'products', 'delete', 'Delete products'),

  ('perm_product_configs_read',   'product-configs', 'read',   'View product configs'),
  ('perm_product_configs_create', 'product-configs', 'create', 'Create product configs'),
  ('perm_product_configs_update', 'product-configs', 'update', 'Edit product configs'),
  ('perm_product_configs_delete', 'product-configs', 'delete', 'Delete product configs'),

  ('perm_drivers_read',   'drivers', 'read',   'View drivers'),
  ('perm_drivers_create', 'drivers', 'create', 'Create drivers'),
  ('perm_drivers_update', 'drivers', 'update', 'Edit drivers'),
  ('perm_drivers_delete', 'drivers', 'delete', 'Delete drivers'),

  ('perm_lorries_read',   'lorries', 'read',   'View lorries'),
  ('perm_lorries_create', 'lorries', 'create', 'Create lorries'),
  ('perm_lorries_update', 'lorries', 'update', 'Edit lorries'),
  ('perm_lorries_delete', 'lorries', 'delete', 'Delete lorries'),

  ('perm_equipment_read',   'equipment', 'read',   'View equipment'),
  ('perm_equipment_create', 'equipment', 'create', 'Create equipment'),
  ('perm_equipment_update', 'equipment', 'update', 'Edit equipment'),
  ('perm_equipment_delete', 'equipment', 'delete', 'Delete equipment'),

  ('perm_maintenance_logs_read',   'maintenance-logs', 'read',   'View maintenance logs'),
  ('perm_maintenance_logs_create', 'maintenance-logs', 'create', 'Create maintenance logs'),
  ('perm_maintenance_logs_update', 'maintenance-logs', 'update', 'Edit maintenance logs'),
  ('perm_maintenance_logs_delete', 'maintenance-logs', 'delete', 'Delete maintenance logs'),

  ('perm_departments_read',   'departments', 'read',   'View departments'),
  ('perm_departments_create', 'departments', 'create', 'Create departments'),
  ('perm_departments_update', 'departments', 'update', 'Edit departments'),
  ('perm_departments_delete', 'departments', 'delete', 'Delete departments'),

  ('perm_organisations_read',   'organisations', 'read',   'View organisations'),
  ('perm_organisations_create', 'organisations', 'create', 'Create organisations'),
  ('perm_organisations_update', 'organisations', 'update', 'Edit organisations'),
  ('perm_organisations_delete', 'organisations', 'delete', 'Delete organisations'),

  ('perm_notifications_read',   'notifications', 'read',   'View notifications'),
  ('perm_notifications_create', 'notifications', 'create', 'Create notifications'),
  ('perm_notifications_update', 'notifications', 'update', 'Edit notifications'),
  ('perm_notifications_delete', 'notifications', 'delete', 'Delete notifications'),

  ('perm_historical_sales_read',   'historical-sales', 'read',   'View historical sales'),
  ('perm_historical_sales_create', 'historical-sales', 'create', 'Create historical sales records'),
  ('perm_historical_sales_update', 'historical-sales', 'update', 'Edit historical sales records'),
  ('perm_historical_sales_delete', 'historical-sales', 'delete', 'Delete historical sales records'),

  ('perm_users_read',   'users', 'read',   'View users'),
  ('perm_users_create', 'users', 'create', 'Create users'),
  ('perm_users_update', 'users', 'update', 'Edit users'),
  ('perm_users_delete', 'users', 'delete', 'Delete users') ON CONFLICT DO NOTHING;

-- ============================================================================
-- 4. ROLE → PERMISSION MATRIX
-- ============================================================================

-- --- SUPER_ADMIN: every permission -------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_super_admin', id FROM permissions ON CONFLICT DO NOTHING;

-- --- READ_ONLY: every read permission ----------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_read_only', id FROM permissions WHERE action = 'read' ON CONFLICT DO NOTHING;

-- --- FINANCE: full on finance domains; read on cross-cutting refs -----------
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_finance', id FROM permissions
WHERE resource IN (
  'invoices', 'payments', 'credit-notes', 'debit-notes', 'e-invoices',
  'accounting', 'cost-ledger', 'three-way-match', 'cash-flow'
) ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_finance', id FROM permissions
WHERE action = 'read'
  AND resource IN ('sales-orders', 'purchase-orders', 'customers', 'suppliers') ON CONFLICT DO NOTHING;

-- --- PROCUREMENT: full on procurement domains; read on production refs ------
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_procurement', id FROM permissions
WHERE resource IN (
  'purchase-orders', 'grn', 'suppliers', 'supplier-materials',
  'supplier-scorecards', 'raw-materials', 'three-way-match',
  'goods-in-transit', 'price-history'
) ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_procurement', id FROM permissions
WHERE action = 'read'
  AND resource IN ('production-orders', 'bom', 'fabrics') ON CONFLICT DO NOTHING;

-- --- PRODUCTION: full on production domains; read on inputs -----------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_production', id FROM permissions
WHERE resource IN (
  'production-orders', 'job-cards', 'bom', 'bom-master-templates',
  'scheduling', 'mrp', 'fg-units', 'fabric-tracking'
) ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_production', id FROM permissions
WHERE action = 'read'
  AND resource IN ('sales-orders', 'products', 'raw-materials', 'inventory') ON CONFLICT DO NOTHING;

-- --- WAREHOUSE: full on inventory/warehouse; read on upstream/downstream ---
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_warehouse', id FROM permissions
WHERE resource IN (
  'inventory', 'warehouse', 'fabrics', 'fabric-tracking',
  'stock-accounts', 'stock-value', 'fg-units', 'stock-movements'
) ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_warehouse', id FROM permissions
WHERE action = 'read'
  AND resource IN ('production-orders', 'purchase-orders', 'grn') ON CONFLICT DO NOTHING;

-- --- SALES: full on sales domains; read on production status / inventory ---
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_sales', id FROM permissions
WHERE resource IN (
  'sales-orders', 'customers', 'customer-hubs',
  'delivery-orders', 'consignments', 'consignment-notes'
) ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_sales', id FROM permissions
WHERE action = 'read'
  AND resource IN ('production-orders', 'products', 'inventory', 'fg-units') ON CONFLICT DO NOTHING;

-- --- WORKER: read-only access to portal-relevant resources -------------------
-- (Per-user "own" filtering is the middleware's job in P3.3 — SQL only grants
-- the resource-level capability here.)
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_worker', id FROM permissions
WHERE action = 'read'
  AND resource IN ('payslips', 'attendance', 'production-orders', 'job-cards') ON CONFLICT DO NOTHING;

-- ============================================================================
-- 5. BACKFILL EXISTING USERS
-- ============================================================================

-- Existing users get a roleId based on their legacy role string.
UPDATE users SET role_id = 'role_super_admin' WHERE role = 'SUPER_ADMIN' AND role_id IS NULL;
UPDATE users SET role_id = 'role_worker'      WHERE role = 'WORKER'      AND role_id IS NULL;
-- STAFF defaults to read_only until per-user assignment.
UPDATE users SET role_id = 'role_read_only'   WHERE role = 'STAFF'       AND role_id IS NULL;
-- Anyone else (unknown role) defaults to read_only.
UPDATE users SET role_id = 'role_read_only'   WHERE role_id IS NULL;
