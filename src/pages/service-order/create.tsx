// 0134 — Service Order create. Re-exports the Sales Order create page.
// The page detects URL mode via useSOMode() and:
//   * sends `isServiceOrder: true` on POST /api/sales-orders
//   * navigates land on /service-order/:id
//   * surfaces the "Copy from SO/CO" button at the top of the form
//   * page title reads "New Service Order"
// See src/pages/service-order/index.tsx for the no-fork rationale.
export { default } from "@/pages/sales/create";
