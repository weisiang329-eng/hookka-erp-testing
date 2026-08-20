// ---------------------------------------------------------------------------
// invoice-detail-export — fetch the lines for a set of invoices and hand them
// to the pure mapper in `invoice-detail-listing.ts`.
//
// Split out of the invoices page for two reasons. The page may only export
// components (react-refresh), and more usefully: the pacing and the failure
// handling below are the parts most likely to be wrong, so they belong
// somewhere a test can reach them.
// ---------------------------------------------------------------------------

import {
  buildInvoiceDetailListingAoa,
  type InvoiceDetailDoc,
  type InvoiceDetailItem,
} from "./invoice-detail-listing";

/**
 * How many invoices one Detail Listing may pull without asking.
 *
 * Each costs two requests (the invoice and its `/print-extras`), and this API
 * SERIALISES concurrent requests and aborts them under load — measured on
 * 2026-08-20, a 500-invoice sweep died with "signal is aborted without reason"
 * three separate times before it was paced. A cap plus a confirm beats an
 * export that half-fails and hands over a file that looks complete.
 */
export const DETAIL_EXPORT_CAP = 200;

/**
 * Gap between invoices. Not a magic number: the same sweep ran clean at this
 * spacing and aborted below it.
 */
export const DETAIL_EXPORT_GAP_MS = 250;

export type InvoiceRowLike = { id?: string | null; invoiceNo?: string | null };

export type DetailExportDeps = {
  /** Injected so tests can drive this without a network. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Injected so tests do not wait in real time. */
  wait?: (ms: number) => Promise<void>;
  /** Returns true to proceed past the cap. Defaults to `window.confirm`. */
  confirmLarge?: (count: number, minutes: number) => boolean;
};

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/**
 * Fetch every line of every invoice given, and map it to the export rows.
 *
 * Failures are REPORTED, never skipped quietly: an invoice whose lines could
 * not be read is emitted as a single row carrying the reason, so a short export
 * is visibly short. A silently dropped invoice is how a spreadsheet comes to be
 * trusted for something it does not contain — and this codebase has already
 * paid for one absence read as a value today (BUG-2026-08-20-158).
 */
export async function buildInvoiceDetailRows(
  rows: InvoiceRowLike[],
  deps: DetailExportDeps = {},
) {
  const getJson = deps.fetchJson ?? defaultFetchJson;
  const wait =
    deps.wait ??
    ((ms: number) => new Promise<void>((res) => window.setTimeout(res, ms)));
  const confirmLarge =
    deps.confirmLarge ??
    ((count: number, minutes: number) =>
      window.confirm(
        `This will read ${count} invoices one at a time — roughly ${minutes} minute(s).\n\n` +
          `Filter the list first if you only need part of it. Continue?`,
      ));

  const wanted = rows.filter((r) => r.id);
  if (wanted.length > DETAIL_EXPORT_CAP) {
    const minutes = Math.ceil((wanted.length * DETAIL_EXPORT_GAP_MS * 2) / 1000 / 60);
    if (!confirmLarge(wanted.length, minutes)) return buildInvoiceDetailListingAoa([]);
  }

  const docs: InvoiceDetailDoc[] = [];
  for (const r of wanted) {
    const id = String(r.id);
    try {
      const invJson = (await getJson(`/api/invoices/${encodeURIComponent(id)}`)) as {
        data?: InvoiceDetailDoc;
      };
      const inv = invJson?.data ?? ({} as InvoiceDetailDoc);

      // `/print-extras` carries the per-line category and the resolved
      // references. Without it the export still works — it just cannot say
      // which components apply, so all five render. Losing the enrichment must
      // never lose the invoice.
      let extras: Record<string, Partial<InvoiceDetailItem>> = {};
      try {
        const exJson = (await getJson(
          `/api/invoices/${encodeURIComponent(id)}/print-extras`,
        )) as { data?: { items?: Record<string, Partial<InvoiceDetailItem>> } };
        extras = exJson?.data?.items ?? {};
      } catch {
        // keep the invoice, lose only the enrichment
      }

      docs.push({
        ...inv,
        items: (inv.items ?? []).map((it) => ({
          ...it,
          ...(extras[String(it.id)] ?? {}),
        })),
      });
    } catch (e) {
      docs.push({
        invoiceNo: r.invoiceNo ?? id,
        status: `EXPORT FAILED — ${e instanceof Error ? e.message : "unknown"}`,
        items: [],
      });
    }
    await wait(DETAIL_EXPORT_GAP_MS);
  }
  return buildInvoiceDetailListingAoa(docs);
}
