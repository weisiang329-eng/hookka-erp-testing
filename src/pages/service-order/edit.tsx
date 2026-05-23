// 0134 — Service Order edit. Re-exports the Sales Order edit page.
// useSOMode() flips internal navigate paths to /service-order/... and the
// page header to "Edit Service Order". The PUT body preserves the row's
// existing isServiceOrder flag.
// See src/pages/service-order/index.tsx for the no-fork rationale.
export { default } from "@/pages/sales/edit";
