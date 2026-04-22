import { Hono } from 'hono';
import { promiseDateCalcs, products, departments } from '../../lib/mock-data';

const app = new Hono();

// GET /api/promise-date?productId=xxx
app.get('/', (c) => {
  const productId = c.req.query('productId');

  if (!productId) {
    const enriched = promiseDateCalcs.map((p) => {
      const product = products.find((pr) => pr.id === p.productId);
      return {
        ...p,
        productName: product?.name ?? 'Unknown',
        productCode: product?.code ?? '',
        departments: product?.deptWorkingTimes.map((dwt) => {
          const dept = departments.find((d) => d.code === dwt.departmentCode);
          return {
            departmentCode: dwt.departmentCode,
            departmentName: dept?.name ?? dwt.departmentCode,
            minutesPerUnit: dwt.minutes,
          };
        }) ?? [],
      };
    });
    return c.json(enriched);
  }

  const calc = promiseDateCalcs.find((p) => p.productId === productId);
  if (!calc) return c.json({ error: 'Product not found' }, 404);

  const product = products.find((p) => p.id === productId);
  const enriched = {
    ...calc,
    productName: product?.name ?? 'Unknown',
    productCode: product?.code ?? '',
    departments: product?.deptWorkingTimes.map((dwt) => {
      const dept = departments.find((d) => d.code === dwt.departmentCode);
      return {
        departmentCode: dwt.departmentCode,
        departmentName: dept?.name ?? dwt.departmentCode,
        minutesPerUnit: dwt.minutes,
      };
    }) ?? [],
  };

  return c.json(enriched);
});

export default app;
