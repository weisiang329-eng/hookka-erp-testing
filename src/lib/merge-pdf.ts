// Shared "merge several jsPDF documents into one downloadable PDF" helper.
//
// Each source document is built independently (so its own internal "Page X of
// Y" footer stays per-document), then pdf-lib copies every page into a single
// output file. Used by the bulk "Download PDF" actions on the Invoices / Sales
// Orders / Purchase Orders list pages (and anywhere a batch of documents should
// download as one file). pdf-lib is dynamically imported so it only loads when
// a bulk download actually runs.
import type jsPDF from "jspdf";

// Trigger a browser download of `bytes` as `filename`.
function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadMergedPdf(
  docs: jsPDF[],
  filename: string,
): Promise<void> {
  if (docs.length === 0) return;
  // One document — no merge needed; save it directly (keeps jsPDF's own
  // filename-sanitising path and avoids loading pdf-lib for a single file).
  if (docs.length === 1) {
    docs[0].save(filename);
    return;
  }
  const { PDFDocument } = await import("pdf-lib");
  const merged = await PDFDocument.create();
  for (const d of docs) {
    const src = await PDFDocument.load(d.output("arraybuffer") as ArrayBuffer);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }
  downloadBytes(await merged.save(), filename);
}
