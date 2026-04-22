import { Hono } from 'hono';
import { salesOrders, productionOrders, deliveryOrders, invoices, customers } from '../../lib/mock-data';

const app = new Hono();

// GET /api/portal/orders?customerId=cust-2
app.get('/orders', (c) => {
  const customerId = c.req.query('customerId') || 'cust-2';

  const orders = salesOrders.filter((so) => so.customerId === customerId);

  const ordersWithProgress = orders.map((so) => {
    const pos = productionOrders.filter((po) => po.salesOrderId === so.id);
    const totalDepts = pos.length * 8;
    const completedDepts = pos.reduce(
      (sum, po) => sum + po.jobCards.filter((jc) => jc.status === 'COMPLETED').length,
      0
    );
    const overallProgress = totalDepts > 0 ? Math.round((completedDepts / totalDepts) * 100) : 0;

    return { ...so, productionOrders: pos, overallProgress };
  });

  return c.json({ success: true, data: ordersWithProgress, total: ordersWithProgress.length });
});

// GET /api/portal/deliveries?customerId=cust-2
app.get('/deliveries', (c) => {
  const customerId = c.req.query('customerId') || 'cust-2';
  const deliveries = deliveryOrders.filter((d) => d.customerId === customerId);
  return c.json({ success: true, data: deliveries, total: deliveries.length });
});

// GET /api/portal/account?customerId=cust-2
app.get('/account', (c) => {
  const customerId = c.req.query('customerId') || 'cust-2';

  const customer = customers.find((cu) => cu.id === customerId);
  if (!customer) {
    return c.json({ success: false, error: 'Customer not found' }, 404);
  }

  const customerInvoices = invoices.filter((inv) => inv.customerId === customerId);

  const totalOutstandingSen = customerInvoices.reduce((sum, inv) => {
    if (inv.status !== 'PAID' && inv.status !== 'CANCELLED') {
      return sum + (inv.totalSen - inv.paidAmount);
    }
    return sum;
  }, 0);

  return c.json({
    success: true,
    data: {
      customer: {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        deliveryHubs: customer.deliveryHubs,
        creditTerms: customer.creditTerms,
        creditLimitSen: customer.creditLimitSen,
        outstandingSen: totalOutstandingSen,
        availableCreditSen: customer.creditLimitSen - totalOutstandingSen,
      },
      invoices: customerInvoices,
    },
  });
});

export default app;
