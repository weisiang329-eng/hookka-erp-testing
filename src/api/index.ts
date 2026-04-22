/// <reference types="node" />
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Route imports
import salesOrders from './routes/sales-orders';
import productionOrders from './routes/production-orders';
import deliveryOrders from './routes/delivery-orders';
import invoices from './routes/invoices';
import payments from './routes/payments';
import customers from './routes/customers';
import products from './routes/products';
import drivers from './routes/drivers';
import creditNotes from './routes/credit-notes';
import debitNotes from './routes/debit-notes';
import bom from './routes/bom';
import warehouse from './routes/warehouse';
import inventory from './routes/inventory';
import purchaseOrders from './routes/purchase-orders';
import grn from './routes/grn';
import supplierMaterials from './routes/supplier-materials';
import consignments from './routes/consignments';
import consignmentNotes from './routes/consignment-notes';
import accounting from './routes/accounting';
import scheduling from './routes/scheduling';
import mrp from './routes/mrp';
import forecasts from './routes/forecasts';
import portal from './routes/portal';
import fabricTracking from './routes/fabric-tracking';
import fabrics from './routes/fabrics';
import eInvoices from './routes/e-invoices';
import suppliers from './routes/suppliers';
import workers from './routes/workers';
import approvals from './routes/approvals';
import attendance from './routes/attendance';
import cashFlow from './routes/cash-flow';
import customerHubs from './routes/customer-hubs';
import departments from './routes/departments';
import dev from './routes/dev';
import equipment from './routes/equipment';
import maintenanceLogs from './routes/maintenance-logs';
import notifications from './routes/notifications';
import organisations from './routes/organisations';
import payroll from './routes/payroll';
import payslips from './routes/payslips';
import leaves from './routes/leaves';
import goodsInTransit from './routes/goods-in-transit';
import historicalSales from './routes/historical-sales';
import lorries from './routes/lorries';
import productConfigs from './routes/product-configs';
import productionLeadtimes from './routes/production-leadtimes';
import promiseDate from './routes/promise-date';
import qcInspections from './routes/qc-inspections';
import rdProjects from './routes/rd-projects';
import stockAccounts from './routes/stock-accounts';
import stockValue from './routes/stock-value';
import supplierScorecards from './routes/supplier-scorecards';
import threeWayMatch from './routes/three-way-match';
import priceHistory from './routes/price-history';
import fgUnits from './routes/fg-units';
import workerAuth from './routes/worker-auth';
import workerApi from './routes/worker';
import costLedger from './routes/cost-ledger';

const app = new Hono();

// CORS
app.use('/*', cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Mount routes
app.route('/api/sales-orders', salesOrders);
app.route('/api/production-orders', productionOrders);
app.route('/api/delivery-orders', deliveryOrders);
app.route('/api/invoices', invoices);
app.route('/api/payments', payments);
app.route('/api/customers', customers);
app.route('/api/products', products);
app.route('/api/drivers', drivers);
app.route('/api/credit-notes', creditNotes);
app.route('/api/debit-notes', debitNotes);
app.route('/api/bom', bom);
app.route('/api/warehouse', warehouse);
app.route('/api/inventory', inventory);
app.route('/api/purchase-orders', purchaseOrders);
app.route('/api/grn', grn);
app.route('/api/supplier-materials', supplierMaterials);
app.route('/api/consignments', consignments);
app.route('/api/consignment-notes', consignmentNotes);
app.route('/api/accounting', accounting);
app.route('/api/scheduling', scheduling);
app.route('/api/mrp', mrp);
app.route('/api/forecasts', forecasts);
app.route('/api/portal', portal);
app.route('/api/fabric-tracking', fabricTracking);
app.route('/api/fabrics', fabrics);
app.route('/api/e-invoices', eInvoices);
app.route('/api/suppliers', suppliers);
app.route('/api/workers', workers);
app.route('/api/approvals', approvals);
app.route('/api/attendance', attendance);
app.route('/api/cash-flow', cashFlow);
app.route('/api/customer-hubs', customerHubs);
app.route('/api/departments', departments);
app.route('/api/dev', dev);
app.route('/api/equipment', equipment);
app.route('/api/maintenance-logs', maintenanceLogs);
app.route('/api/notifications', notifications);
app.route('/api/organisations', organisations);
app.route('/api/payroll', payroll);
app.route('/api/payslips', payslips);
app.route('/api/leaves', leaves);
app.route('/api/goods-in-transit', goodsInTransit);
app.route('/api/historical-sales', historicalSales);
app.route('/api/lorries', lorries);
app.route('/api/product-configs', productConfigs);
app.route('/api/production/leadtimes', productionLeadtimes);
app.route('/api/promise-date', promiseDate);
app.route('/api/qc-inspections', qcInspections);
app.route('/api/rd-projects', rdProjects);
app.route('/api/stock-accounts', stockAccounts);
app.route('/api/stock-value', stockValue);
app.route('/api/supplier-scorecards', supplierScorecards);
app.route('/api/three-way-match', threeWayMatch);
app.route('/api/price-history', priceHistory);
app.route('/api/fg-units', fgUnits);
app.route('/api/worker-auth', workerAuth);
app.route('/api/worker', workerApi);
app.route('/api/cost-ledger', costLedger);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

const port = Number(process.env.API_PORT) || 3001;

console.log(`Hookka ERP API server starting on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`Hookka ERP API server running at http://localhost:${port}`);

export default app;
