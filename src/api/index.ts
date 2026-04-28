/// <reference types="node" />
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Route imports
import salesOrders from './routes-mock/sales-orders';
import productionOrders from './routes-mock/production-orders';
import deliveryOrders from './routes-mock/delivery-orders';
import invoices from './routes-mock/invoices';
import payments from './routes-mock/payments';
import customers from './routes-mock/customers';
import products from './routes-mock/products';
import drivers from './routes-mock/drivers';
import creditNotes from './routes-mock/credit-notes';
import debitNotes from './routes-mock/debit-notes';
import bom from './routes-mock/bom';
import warehouse from './routes-mock/warehouse';
import inventory from './routes-mock/inventory';
import purchaseOrders from './routes-mock/purchase-orders';
import grn from './routes-mock/grn';
import supplierMaterials from './routes-mock/supplier-materials';
import consignments from './routes-mock/consignments';
import consignmentNotes from './routes-mock/consignment-notes';
import accounting from './routes-mock/accounting';
import scheduling from './routes-mock/scheduling';
import mrp from './routes-mock/mrp';
import forecasts from './routes-mock/forecasts';
import fabricTracking from './routes-mock/fabric-tracking';
import fabrics from './routes-mock/fabrics';
import eInvoices from './routes-mock/e-invoices';
import suppliers from './routes-mock/suppliers';
import workers from './routes-mock/workers';
import attendance from './routes-mock/attendance';
import cashFlow from './routes-mock/cash-flow';
import customerHubs from './routes-mock/customer-hubs';
import departments from './routes-mock/departments';
import dev from './routes-mock/dev';
import equipment from './routes-mock/equipment';
import maintenanceLogs from './routes-mock/maintenance-logs';
import notifications from './routes-mock/notifications';
import organisations from './routes-mock/organisations';
import payroll from './routes-mock/payroll';
import payslips from './routes-mock/payslips';
import leaves from './routes-mock/leaves';
import goodsInTransit from './routes-mock/goods-in-transit';
import historicalSales from './routes-mock/historical-sales';
import lorries from './routes-mock/lorries';
import productConfigs from './routes-mock/product-configs';
import productionLeadtimes from './routes-mock/production-leadtimes';
import promiseDate from './routes-mock/promise-date';
import qcInspections from './routes-mock/qc-inspections';
import rdProjects from './routes-mock/rd-projects';
import stockAccounts from './routes-mock/stock-accounts';
import stockValue from './routes-mock/stock-value';
import supplierScorecards from './routes-mock/supplier-scorecards';
import threeWayMatch from './routes-mock/three-way-match';
import priceHistory from './routes-mock/price-history';
import fgUnits from './routes-mock/fg-units';
import workerAuth from './routes-mock/worker-auth';
import workerApi from './routes-mock/worker';
import costLedger from './routes-mock/cost-ledger';

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
app.route('/api/fabric-tracking', fabricTracking);
app.route('/api/fabrics', fabrics);
app.route('/api/e-invoices', eInvoices);
app.route('/api/suppliers', suppliers);
app.route('/api/workers', workers);
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
