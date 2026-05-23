// ---------------------------------------------------------------------------
// Service Order list — re-export of the Sales Order list.
//
// 0134 (Service Order module): the underlying SalesPage component reads
// useSOMode() to detect whether the URL starts with /service-order, then
// flips:
//   * the fetch URL filter (?isServiceOrder=true)
//   * the page header copy ("Service Orders")
//   * the "+ New Service Order" button label
//   * every internal navigate(...) base path
//
// We don't fork the 1400-line list page into a parallel tree — that would
// silently drift on every bug fix to the sales pipeline (status badges,
// outstanding column, bulk actions, CSV export, …). Same applies to the
// create / edit / detail pages re-exported under this directory.
// See src/lib/so-mode.ts for the rationale.
// ---------------------------------------------------------------------------
export { default } from "@/pages/sales";
