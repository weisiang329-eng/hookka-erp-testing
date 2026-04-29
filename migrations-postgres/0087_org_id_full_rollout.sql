-- ---------------------------------------------------------------------------
-- 0078_org_id_full_rollout.sql — Sprint 4 multi-tenant finish step.
--
-- Migration 0049 added org_id to the 6 highest-leak tables (sales_orders,
-- customers, invoices, production_orders, audit_events, users); 0051 / 0052
-- / 0055 covered ledger_journal_entries, mdm_review_queue, file_assets.
-- This migration backfills the long tail of transaction tables so the
-- withOrgScope() helper can attach a `WHERE orgId = ?` predicate
-- everywhere — once a second org seeds the system, no list query can
-- accidentally cross the tenant boundary.
--
-- Conventions (matches 0049):
--   * snake_case column names — d1-compat rewrites orgId <-> org_id.
--   * NOT NULL DEFAULT 'hookka' so existing rows backfill in-place.
--   * IF NOT EXISTS on every ADD COLUMN / CREATE INDEX so the migration is
--     re-runnable. IF EXISTS guard on the table itself so missing tables
--     (legacy / never-deployed) don't abort the whole batch.
--
-- Tables intentionally OMITTED:
--   * sales_orders_archive / production_orders_archive / job_cards_archive
--     — historical snapshots, scoped via the live table they descended
--     from. Adding org_id post-archive would force a backfill question we
--     don't want during the launch crunch.
--   * Materialized views (mv_*) — re-built from base tables which are
--     scoped, so MVs inherit the scope on next REFRESH.
--   * Worker-portal tables (worker_pins / worker_sessions / worker_tokens
--     / workers) — single-org PIN flow today. Tracked as Sprint 5+.
--   * RBAC tables (roles / permissions / role_permissions) — global by
--     design (one matrix shared across orgs).
--   * Pure config / lookup tables (departments, leg_height_options,
--     divan_height_options, kv_config, dept_lead_times,
--     dept_working_times, special_order_options) — global to the
--     install today. Tracked for Sprint 5+ if multi-org config diverges.
-- ---------------------------------------------------------------------------

-- ----- Sales / SO satellite tables ----------------------------------------
ALTER TABLE IF EXISTS sales_order_items   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS so_status_changes   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS price_overrides     ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_sales_order_items_org_id ON sales_order_items(org_id);
CREATE INDEX IF NOT EXISTS idx_so_status_changes_org_id ON so_status_changes(org_id);
CREATE INDEX IF NOT EXISTS idx_price_overrides_org_id   ON price_overrides(org_id);

-- ----- Purchase / PO chain ------------------------------------------------
ALTER TABLE IF EXISTS purchase_orders        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS purchase_order_items   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS purchase_invoices      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS po_scan_samples        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS three_way_matches      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS goods_in_transit       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS price_histories        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_purchase_orders_org_id      ON purchase_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_org_id ON purchase_order_items(org_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_org_id    ON purchase_invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_po_scan_samples_org_id      ON po_scan_samples(org_id);
CREATE INDEX IF NOT EXISTS idx_three_way_matches_org_id    ON three_way_matches(org_id);
CREATE INDEX IF NOT EXISTS idx_goods_in_transit_org_id     ON goods_in_transit(org_id);
CREATE INDEX IF NOT EXISTS idx_price_histories_org_id      ON price_histories(org_id);

-- ----- Delivery / GRN / Logistics -----------------------------------------
ALTER TABLE IF EXISTS delivery_orders        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS delivery_order_items   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS delivery_hubs          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS grns                   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS grn_items              ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS lorries                ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS drivers                ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS three_pl_providers     ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS three_pl_vehicles      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS three_pl_drivers       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_delivery_orders_org_id      ON delivery_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_delivery_order_items_org_id ON delivery_order_items(org_id);
CREATE INDEX IF NOT EXISTS idx_delivery_hubs_org_id        ON delivery_hubs(org_id);
CREATE INDEX IF NOT EXISTS idx_grns_org_id                 ON grns(org_id);
CREATE INDEX IF NOT EXISTS idx_grn_items_org_id            ON grn_items(org_id);
CREATE INDEX IF NOT EXISTS idx_lorries_org_id              ON lorries(org_id);
CREATE INDEX IF NOT EXISTS idx_drivers_org_id              ON drivers(org_id);
CREATE INDEX IF NOT EXISTS idx_three_pl_providers_org_id   ON three_pl_providers(org_id);
CREATE INDEX IF NOT EXISTS idx_three_pl_vehicles_org_id    ON three_pl_vehicles(org_id);
CREATE INDEX IF NOT EXISTS idx_three_pl_drivers_org_id     ON three_pl_drivers(org_id);

-- ----- Invoice / AR / Credit / Debit / e-Invoice --------------------------
ALTER TABLE IF EXISTS invoice_items          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS invoice_payments       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS payment_records        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS credit_notes           ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS debit_notes            ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS e_invoices             ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS ar_aging               ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS ap_aging               ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_invoice_items_org_id      ON invoice_items(org_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_org_id   ON invoice_payments(org_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_org_id    ON payment_records(org_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_org_id       ON credit_notes(org_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_org_id        ON debit_notes(org_id);
CREATE INDEX IF NOT EXISTS idx_e_invoices_org_id         ON e_invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_ar_aging_org_id           ON ar_aging(org_id);
CREATE INDEX IF NOT EXISTS idx_ap_aging_org_id           ON ap_aging(org_id);

-- ----- Accounting / Ledger ------------------------------------------------
ALTER TABLE IF EXISTS journal_entries        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS journal_lines          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS chart_of_accounts      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS bank_accounts          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS bank_transactions      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS balance_sheet_entries  ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS pl_entries             ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS approval_requests      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS cost_ledger            ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS inter_company_config   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_journal_entries_org_id     ON journal_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_org_id       ON journal_lines(org_id);
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_org_id   ON chart_of_accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_org_id       ON bank_accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_org_id   ON bank_transactions(org_id);
CREATE INDEX IF NOT EXISTS idx_balance_sheet_entries_org_id ON balance_sheet_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_pl_entries_org_id          ON pl_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_org_id   ON approval_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_org_id         ON cost_ledger(org_id);
CREATE INDEX IF NOT EXISTS idx_inter_company_config_org_id ON inter_company_config(org_id);

-- ----- Payroll / HR -------------------------------------------------------
ALTER TABLE IF EXISTS payslips               ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS payslip_details        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS payroll_records        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS attendance_records     ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS working_hour_entries   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS leaves                 ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS leave_records          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_payslips_org_id             ON payslips(org_id);
CREATE INDEX IF NOT EXISTS idx_payslip_details_org_id      ON payslip_details(org_id);
CREATE INDEX IF NOT EXISTS idx_payroll_records_org_id      ON payroll_records(org_id);
CREATE INDEX IF NOT EXISTS idx_attendance_records_org_id   ON attendance_records(org_id);
CREATE INDEX IF NOT EXISTS idx_working_hour_entries_org_id ON working_hour_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_leaves_org_id               ON leaves(org_id);
CREATE INDEX IF NOT EXISTS idx_leave_records_org_id        ON leave_records(org_id);

-- ----- Production / Job Cards / WIP / FG ----------------------------------
ALTER TABLE IF EXISTS job_cards              ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS job_card_events        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS fg_units               ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS fg_batches             ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS fg_scan_history        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS wip_items              ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS piece_pics             ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS schedule_entries       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS promise_date_calcs     ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_job_cards_org_id          ON job_cards(org_id);
CREATE INDEX IF NOT EXISTS idx_job_card_events_org_id    ON job_card_events(org_id);
CREATE INDEX IF NOT EXISTS idx_fg_units_org_id           ON fg_units(org_id);
CREATE INDEX IF NOT EXISTS idx_fg_batches_org_id         ON fg_batches(org_id);
CREATE INDEX IF NOT EXISTS idx_fg_scan_history_org_id    ON fg_scan_history(org_id);
CREATE INDEX IF NOT EXISTS idx_wip_items_org_id          ON wip_items(org_id);
CREATE INDEX IF NOT EXISTS idx_piece_pics_org_id         ON piece_pics(org_id);
CREATE INDEX IF NOT EXISTS idx_schedule_entries_org_id   ON schedule_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_promise_date_calcs_org_id ON promise_date_calcs(org_id);

-- ----- Inventory / Stock --------------------------------------------------
ALTER TABLE IF EXISTS rm_batches             ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS stock_movements        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS stock_adjustments      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS stock_accounts         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS monthly_stock_values   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS rack_locations         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS rack_items             ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS fabrics                ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS fabric_trackings       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS raw_materials          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS material_substitutes   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_rm_batches_org_id           ON rm_batches(org_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_org_id      ON stock_movements(org_id);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_org_id    ON stock_adjustments(org_id);
CREATE INDEX IF NOT EXISTS idx_stock_accounts_org_id       ON stock_accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_monthly_stock_values_org_id ON monthly_stock_values(org_id);
CREATE INDEX IF NOT EXISTS idx_rack_locations_org_id       ON rack_locations(org_id);
CREATE INDEX IF NOT EXISTS idx_rack_items_org_id           ON rack_items(org_id);
CREATE INDEX IF NOT EXISTS idx_fabrics_org_id              ON fabrics(org_id);
CREATE INDEX IF NOT EXISTS idx_fabric_trackings_org_id     ON fabric_trackings(org_id);
CREATE INDEX IF NOT EXISTS idx_raw_materials_org_id        ON raw_materials(org_id);
CREATE INDEX IF NOT EXISTS idx_material_substitutes_org_id ON material_substitutes(org_id);

-- ----- Suppliers ----------------------------------------------------------
ALTER TABLE IF EXISTS suppliers                  ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS supplier_materials         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS supplier_scorecards        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS supplier_material_bindings ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_suppliers_org_id                  ON suppliers(org_id);
CREATE INDEX IF NOT EXISTS idx_supplier_materials_org_id         ON supplier_materials(org_id);
CREATE INDEX IF NOT EXISTS idx_supplier_scorecards_org_id        ON supplier_scorecards(org_id);
CREATE INDEX IF NOT EXISTS idx_supplier_material_bindings_org_id ON supplier_material_bindings(org_id);

-- ----- Products / BOM / Pricing -------------------------------------------
ALTER TABLE IF EXISTS products                ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS product_dept_configs    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS customer_products       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS customer_product_prices ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS customer_hubs           ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS bom_master_templates    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS bom_templates           ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS bom_versions            ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS bom_components          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_products_org_id                ON products(org_id);
CREATE INDEX IF NOT EXISTS idx_product_dept_configs_org_id    ON product_dept_configs(org_id);
CREATE INDEX IF NOT EXISTS idx_customer_products_org_id       ON customer_products(org_id);
CREATE INDEX IF NOT EXISTS idx_customer_product_prices_org_id ON customer_product_prices(org_id);
CREATE INDEX IF NOT EXISTS idx_customer_hubs_org_id           ON customer_hubs(org_id);
CREATE INDEX IF NOT EXISTS idx_bom_master_templates_org_id    ON bom_master_templates(org_id);
CREATE INDEX IF NOT EXISTS idx_bom_templates_org_id           ON bom_templates(org_id);
CREATE INDEX IF NOT EXISTS idx_bom_versions_org_id            ON bom_versions(org_id);
CREATE INDEX IF NOT EXISTS idx_bom_components_org_id          ON bom_components(org_id);

-- ----- MRP / Forecasting / Historical -------------------------------------
ALTER TABLE IF EXISTS mrp_runs               ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS mrp_requirements       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS forecast_entries       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS historical_sales       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_mrp_runs_org_id          ON mrp_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_mrp_requirements_org_id  ON mrp_requirements(org_id);
CREATE INDEX IF NOT EXISTS idx_forecast_entries_org_id  ON forecast_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_historical_sales_org_id  ON historical_sales(org_id);

-- ----- QC -----------------------------------------------------------------
ALTER TABLE IF EXISTS qc_inspections         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS qc_inspection_items    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS qc_defects             ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS qc_tags                ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS qc_templates           ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS qc_template_items      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS scan_override_audit    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS edit_lock_overrides    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_qc_inspections_org_id      ON qc_inspections(org_id);
CREATE INDEX IF NOT EXISTS idx_qc_inspection_items_org_id ON qc_inspection_items(org_id);
CREATE INDEX IF NOT EXISTS idx_qc_defects_org_id          ON qc_defects(org_id);
CREATE INDEX IF NOT EXISTS idx_qc_tags_org_id             ON qc_tags(org_id);
CREATE INDEX IF NOT EXISTS idx_qc_templates_org_id        ON qc_templates(org_id);
CREATE INDEX IF NOT EXISTS idx_qc_template_items_org_id   ON qc_template_items(org_id);
CREATE INDEX IF NOT EXISTS idx_scan_override_audit_org_id ON scan_override_audit(org_id);
CREATE INDEX IF NOT EXISTS idx_edit_lock_overrides_org_id ON edit_lock_overrides(org_id);

-- ----- Service Cases / Orders ---------------------------------------------
ALTER TABLE IF EXISTS service_orders         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS service_order_lines    ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS service_order_returns  ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS service_cases          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_service_orders_org_id        ON service_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_service_order_lines_org_id   ON service_order_lines(org_id);
CREATE INDEX IF NOT EXISTS idx_service_order_returns_org_id ON service_order_returns(org_id);
CREATE INDEX IF NOT EXISTS idx_service_cases_org_id         ON service_cases(org_id);

-- ----- Consignment --------------------------------------------------------
ALTER TABLE IF EXISTS consignment_orders        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS consignment_order_items   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS consignment_notes         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS consignment_items         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_consignment_orders_org_id      ON consignment_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_consignment_order_items_org_id ON consignment_order_items(org_id);
CREATE INDEX IF NOT EXISTS idx_consignment_notes_org_id       ON consignment_notes(org_id);
CREATE INDEX IF NOT EXISTS idx_consignment_items_org_id       ON consignment_items(org_id);

-- ----- Equipment / Maintenance / R&D --------------------------------------
ALTER TABLE IF EXISTS equipment              ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS equipment_list         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS maintenance_logs       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS rd_projects            ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS rd_prototypes          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_equipment_org_id        ON equipment(org_id);
CREATE INDEX IF NOT EXISTS idx_equipment_list_org_id   ON equipment_list(org_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_logs_org_id ON maintenance_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_rd_projects_org_id      ON rd_projects(org_id);
CREATE INDEX IF NOT EXISTS idx_rd_prototypes_org_id    ON rd_prototypes(org_id);

-- ----- Notifications / Identity / Invites / Presence ---------------------
ALTER TABLE IF EXISTS notifications          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS oauth_identities       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS user_invites           ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS user_sessions          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS edit_presence          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_notifications_org_id     ON notifications(org_id);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_org_id  ON oauth_identities(org_id);
CREATE INDEX IF NOT EXISTS idx_user_invites_org_id      ON user_invites(org_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_org_id     ON user_sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_edit_presence_org_id     ON edit_presence(org_id);
