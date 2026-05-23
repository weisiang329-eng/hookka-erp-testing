// 0134 — Service Order detail. Re-exports the Sales Order detail page.
// useSOMode() flips internal navigate paths to /service-order/... and the
// document-flow diagram label to "Service Order". The underlying SO row
// is fetched from the same /api/sales-orders/:id endpoint — no separate
// data model.
// See src/pages/service-order/index.tsx for the no-fork rationale.
export { default } from "@/pages/sales/detail";
