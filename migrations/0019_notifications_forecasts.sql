-- ============================================================================
-- 0013_notifications_forecasts.sql
--
-- Phase 5 migration — first two mock-backed modules that need real D1 storage:
--
--   1. notifications — persistent user-facing alerts. userId is nullable:
--      NULL = global broadcast (visible to everyone), non-NULL = targeted.
--      Existing notification payloads don't carry a userId, so we keep it
--      optional for backward compatibility with the old mock-driven shape.
--
--   2. forecast_entries — manual sales-forecast rows posted by planners.
--      The old mock route had an in-memory array that wiped on every deploy;
--      this table gives the same POST/GET surface real persistence. No
--      relationship to historical_sales (that's derived on-the-fly from
--      invoices and doesn't need its own table).
-- ============================================================================

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  userId TEXT,                 -- nullable → broadcast to all users
  type TEXT NOT NULL CHECK (type IN ('ORDER','PRODUCTION','INVENTORY','DELIVERY','QUALITY','FINANCE','SYSTEM')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  isRead INTEGER NOT NULL DEFAULT 0,
  link TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_createdAt ON notifications(createdAt);
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_isRead ON notifications(isRead);
CREATE INDEX idx_notifications_userId ON notifications(userId);

CREATE TABLE forecast_entries (
  id TEXT PRIMARY KEY,
  productId TEXT NOT NULL,
  productName TEXT,
  productCode TEXT,
  period TEXT NOT NULL,                       -- "YYYY-MM"
  forecastQty INTEGER NOT NULL DEFAULT 0,
  actualQty INTEGER,
  method TEXT NOT NULL CHECK (method IN ('SMA_3','SMA_6','WMA')),
  confidence INTEGER NOT NULL DEFAULT 50,     -- 0-100
  createdDate TEXT NOT NULL
);

CREATE INDEX idx_forecast_entries_productId ON forecast_entries(productId);
CREATE INDEX idx_forecast_entries_period ON forecast_entries(period);

-- --- Seed notifications (matches the old mock-data for parity with the UI) ---
INSERT INTO notifications (id, userId, type, title, message, severity, isRead, link, createdAt) VALUES
  ('notif-001', NULL, 'ORDER',      'New Sales Order Received',     'SO-2604-045 received from HOUZS KL - 8 items totalling RM 18,500.00',                    'INFO',     0, '/sales/SO-2604-045',    '2026-04-14T09:30:00'),
  ('notif-002', NULL, 'INVENTORY',  'Low Stock Alert',              'Premium Black Fabric below reorder point - 12 meters remaining (min: 50)',              'WARNING',  0, '/inventory',            '2026-04-14T08:45:00'),
  ('notif-003', NULL, 'PRODUCTION', 'Production Order Overdue',     'PO-INT-2604-012 is 3 days overdue - assigned to Upholstery department',                 'CRITICAL', 0, '/production',           '2026-04-14T08:00:00'),
  ('notif-004', NULL, 'QUALITY',    'QC Failed',                    'SO-2604-043-02 failed quality check at Upholstery checkpoint - fabric alignment issue', 'WARNING',  0, '/quality',              '2026-04-14T07:30:00'),
  ('notif-005', NULL, 'FINANCE',    'Invoice Overdue',              'INV-2604-008 from CARRESS SDN BHD is overdue by 15 days - RM 7,950.00',                 'WARNING',  0, '/finance/invoices',     '2026-04-14T07:00:00'),
  ('notif-006', NULL, 'DELIVERY',   'Delivery Confirmed',           'DO-2604-005 confirmed arrived at HOUZS PG - signed by warehouse manager',               'INFO',     0, '/delivery',             '2026-04-13T16:30:00'),
  ('notif-007', NULL, 'PRODUCTION', 'Batch Completed',              'Batch B2604-018 has completed all 8 departments - ready for packing',                   'INFO',     0, '/production',           '2026-04-13T15:00:00'),
  ('notif-008', NULL, 'SYSTEM',     'System Backup Complete',       'Daily system backup completed successfully at 02:00 AM - all data secured',             'INFO',     1, NULL,                    '2026-04-13T02:00:00'),
  ('notif-009', NULL, 'INVENTORY',  'Stock Received',               'GRN processed for PO-2604-016 from Foam Industries M''sia - 200 units',                 'INFO',     1, '/inventory',            '2026-04-13T11:30:00'),
  ('notif-010', NULL, 'ORDER',      'Sales Order Shipped',          'SO-2604-042 shipped to THE CONTS SDN BHD via J&T Express - tracking #JT20260413',       'INFO',     1, '/sales/SO-2604-042',    '2026-04-13T10:00:00'),
  ('notif-011', NULL, 'QUALITY',    'QC Inspection Passed',         'Batch B2604-015 passed final QC inspection - all 12 items cleared',                     'INFO',     1, '/quality',              '2026-04-12T16:45:00'),
  ('notif-012', NULL, 'PRODUCTION', 'Machine Maintenance Required', 'Industrial Sewing Machine EQ-UPH-001 maintenance overdue by 5 days',                    'CRITICAL', 0, '/production',           '2026-04-12T14:00:00'),
  ('notif-013', NULL, 'FINANCE',    'Payment Received',             'RM 12,350.00 received from DREAMSCAPE LIVING for INV-2604-003',                         'INFO',     1, '/finance/invoices',     '2026-04-12T11:00:00'),
  ('notif-014', NULL, 'DELIVERY',   'Delivery Scheduled',           'DO-2604-008 scheduled for delivery to ZARA HOME KL on 2026-04-16',                      'INFO',     1, '/delivery',             '2026-04-12T09:30:00'),
  ('notif-015', NULL, 'INVENTORY',  'Reorder Alert',                'Packing Box (King) critically low - 10 units remaining (reorder level: 50)',            'CRITICAL', 0, '/inventory',            '2026-04-11T08:15:00'),
  ('notif-016', NULL, 'ORDER',      'Order On Hold',                'SO-2604-039 placed on hold - pending credit approval for LUMINA DECOR',                 'WARNING',  1, '/sales/SO-2604-039',    '2026-04-11T07:00:00'),
  ('notif-017', NULL, 'SYSTEM',     'User Access Updated',          'New user Tan Mei Ling granted QC Inspector role access',                                'INFO',     1, NULL,                    '2026-04-10T15:45:00'),
  ('notif-018', NULL, 'FINANCE',    'Credit Limit Warning',         'LUMINA DECOR approaching credit limit - RM 45,000 / RM 50,000 utilized',                'WARNING',  1, '/finance',              '2026-04-10T10:00:00');
