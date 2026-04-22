// ---------------------------------------------------------------------------
// D1-backed promise-date route.
//
// Pure calculator — no dedicated table. Estimates the realistic promise date
// per product by combining:
//
//   * current queue days       — sum of estMinutes for WAITING / IN_PROGRESS
//                                job cards on production_orders that use the
//                                product, divided by the daily department
//                                capacity (workingHoursPerDay × 60 min).
//   * material availability    — simple heuristic: if every raw_material row
//                                has balanceQty > 0 we report IN_STOCK; if
//                                some are zero we report PARTIAL; empty RM
//                                table ⇒ NEED_ORDER. Good enough for the
//                                planning dashboard; full MRP-driven check
//                                lives under /api/mrp.
//   * estimated completion days = queueDays + productionDays
//                                where productionDays = totalMinutes-per-unit
//                                / (totalWorkingHoursPerDay × 60).
//
// Response shape mirrors the old mock — each record carries productName,
// productCode and an enriched `departments` array with minutesPerUnit.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type ProductRow = {
  id: string;
  code: string;
  name: string;
  productionTimeMinutes: number;
};

type DeptWorkingTimeRow = {
  productId: string;
  departmentCode: string;
  minutes: number;
};

type DepartmentRow = {
  code: string;
  name: string;
  workingHoursPerDay: number;
};

type QueueRow = {
  productId: string | null;
  totalMinutes: number;
};

type StockRow = {
  total: number;
  zeroCount: number;
};

type PromiseDateCalc = {
  productId: string;
  currentQueueDays: number;
  materialAvailability: "IN_STOCK" | "PARTIAL" | "NEED_ORDER";
  estimatedCompletionDays: number;
  promiseDate: string; // YYYY-MM-DD
};

type EnrichedCalc = PromiseDateCalc & {
  productName: string;
  productCode: string;
  departments: {
    departmentCode: string;
    departmentName: string;
    minutesPerUnit: number;
  }[];
};

async function loadCoreState(db: D1Database) {
  const [products, dwts, depts, queue, stock] = await Promise.all([
    db.prepare("SELECT id, code, name, productionTimeMinutes FROM products").all<ProductRow>(),
    db.prepare(
      "SELECT productId, departmentCode, minutes FROM dept_working_times",
    ).all<DeptWorkingTimeRow>(),
    db.prepare(
      "SELECT code, name, workingHoursPerDay FROM departments",
    ).all<DepartmentRow>(),
    // Active queue load: pending/in-progress job cards on non-completed POs.
    db.prepare(
      `SELECT po.productId AS productId, SUM(jc.estMinutes) AS totalMinutes
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE jc.status IN ('WAITING','IN_PROGRESS','PAUSED','BLOCKED')
          AND po.status IN ('PENDING','IN_PROGRESS','ON_HOLD','PAUSED')
        GROUP BY po.productId`,
    ).all<QueueRow>(),
    // RM stock snapshot for the coarse material-availability heuristic.
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN balanceQty <= 0 THEN 1 ELSE 0 END) AS zeroCount
         FROM raw_materials
        WHERE isActive = 1`,
    ).first<StockRow>(),
  ]);
  return {
    products: products.results ?? [],
    dwts: dwts.results ?? [],
    depts: depts.results ?? [],
    queue: queue.results ?? [],
    stock: stock ?? { total: 0, zeroCount: 0 },
  };
}

function materialAvailability(stock: StockRow): PromiseDateCalc["materialAvailability"] {
  if (!stock.total || stock.total === 0) return "NEED_ORDER";
  if (stock.zeroCount === 0) return "IN_STOCK";
  if (stock.zeroCount >= stock.total) return "NEED_ORDER";
  return "PARTIAL";
}

function isoDateInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + Math.max(0, Math.ceil(days)));
  return d.toISOString().split("T")[0];
}

function buildCalc(
  product: ProductRow,
  dwtByProduct: Map<string, DeptWorkingTimeRow[]>,
  deptByCode: Map<string, DepartmentRow>,
  queueByProduct: Map<string, number>,
  stockStatus: PromiseDateCalc["materialAvailability"],
): EnrichedCalc {
  const rows = dwtByProduct.get(product.id) ?? [];

  // Daily capacity across this product's departments (sum of working hours).
  const totalHoursPerDay = rows.reduce((sum, r) => {
    const dept = deptByCode.get(r.departmentCode);
    return sum + (dept?.workingHoursPerDay ?? 8);
  }, 0);
  const dailyCapacityMinutes = Math.max(1, totalHoursPerDay * 60);

  // Production time for 1 unit → days.
  const productionMinutes = product.productionTimeMinutes || rows.reduce((s, r) => s + r.minutes, 0);
  const productionDays = productionMinutes / dailyCapacityMinutes;

  // Queue days — current backlog on this product.
  const queueMinutes = queueByProduct.get(product.id) ?? 0;
  const queueDays = queueMinutes / dailyCapacityMinutes;

  const estimatedCompletionDays = Math.ceil(queueDays + productionDays);

  return {
    productId: product.id,
    currentQueueDays: Math.ceil(queueDays),
    materialAvailability: stockStatus,
    estimatedCompletionDays,
    promiseDate: isoDateInDays(estimatedCompletionDays),
    productName: product.name,
    productCode: product.code,
    departments: rows.map((r) => ({
      departmentCode: r.departmentCode,
      departmentName: deptByCode.get(r.departmentCode)?.name ?? r.departmentCode,
      minutesPerUnit: r.minutes,
    })),
  };
}

// GET /api/promise-date?productId=xxx
app.get("/", async (c) => {
  const productId = c.req.query("productId");
  const { products, dwts, depts, queue, stock } = await loadCoreState(c.env.DB);

  const dwtByProduct = new Map<string, DeptWorkingTimeRow[]>();
  for (const row of dwts) {
    const list = dwtByProduct.get(row.productId) ?? [];
    list.push(row);
    dwtByProduct.set(row.productId, list);
  }
  const deptByCode = new Map<string, DepartmentRow>();
  for (const d of depts) deptByCode.set(d.code, d);
  const queueByProduct = new Map<string, number>();
  for (const q of queue) {
    if (q.productId) queueByProduct.set(q.productId, q.totalMinutes || 0);
  }
  const stockStatus = materialAvailability(stock);

  if (!productId) {
    const enriched = products.map((p) =>
      buildCalc(p, dwtByProduct, deptByCode, queueByProduct, stockStatus),
    );
    return c.json(enriched);
  }

  const product = products.find((p) => p.id === productId);
  if (!product) return c.json({ error: "Product not found" }, 404);
  const enriched = buildCalc(
    product,
    dwtByProduct,
    deptByCode,
    queueByProduct,
    stockStatus,
  );
  return c.json(enriched);
});

export default app;
