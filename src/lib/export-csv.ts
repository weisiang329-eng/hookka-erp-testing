// ---------------------------------------------------------------------------
// exportToCsv — generic CSV download helper for any list page.
//
// Usage:
//   exportToCsv({
//     filename: 'sales-orders-2026-05-04',
//     columns: [
//       { header: 'SO #', accessor: (r) => r.companySOId },
//       { header: 'Customer', accessor: (r) => r.customerName },
//       { header: 'Total (MYR)', accessor: (r) => (r.totalSen / 100).toFixed(2) },
//     ],
//     rows: salesOrders,
//   })
//
// Triggers a browser download via a temporary <a download> click.
// Excel / Numbers / Sheets all open the result without conversion.
// ---------------------------------------------------------------------------

export type CsvColumn<T> = {
  header: string;
  accessor: (row: T) => string | number | null | undefined;
};

function escape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // RFC 4180: quote any field that contains comma, double-quote, or newline.
  // Embedded quotes are doubled.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportToCsv<T>({
  filename,
  columns,
  rows,
}: {
  /** Without extension; ".csv" is appended. ASCII letters / digits / dashes only. */
  filename: string;
  columns: CsvColumn<T>[];
  rows: readonly T[];
}): void {
  const lines: string[] = [];
  lines.push(columns.map((c) => escape(c.header)).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => escape(c.accessor(row))).join(","));
  }
  // Excel needs a UTF-8 BOM to interpret non-ASCII characters correctly
  // when the file is double-clicked. The cost is 3 bytes; gains the user
  // a non-broken Chinese / Malay character set every time.
  const blob = new Blob(["﻿" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
