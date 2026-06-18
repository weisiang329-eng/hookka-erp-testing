// ---------------------------------------------------------------------------
// Product "study pack" — bundle every uploaded production document for a
// product into ONE PDF a new hire can open and study end-to-end.
//
// Mixed inputs: uploaded docs are images (PNG/JPEG/…) or PDFs. pdf-lib embeds
// PNG/JPEG as full pages and COPIES the pages of any uploaded PDF straight into
// the pack, so the result is a single continuous document. Unsupported image
// types (webp/gif/heic — pdf-lib can't embed them) get a labelled placeholder
// page pointing back to the product's Docs page. pdf-lib is dynamically
// imported so it only loads when an export actually runs.
//
// Files are fetched via GET /api/files/:id/download (302 → presigned URL; the
// browser follows the redirect and we read the bytes).
// ---------------------------------------------------------------------------
export type PackDoc = {
  id: string;
  filename: string;
  contentType: string;
  categoryLabel: string;
};

export type PackProduct = { code: string; name: string; category: string };

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

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 40;

export async function generateProductPackPdf(
  product: PackProduct,
  docs: PackDoc[],
): Promise<void> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pack = await PDFDocument.create();
  const font = await pack.embedFont(StandardFonts.Helvetica);
  const fontBold = await pack.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.11, 0.10);
  const grey = rgb(0.42, 0.45, 0.5);

  // --- Cover + index ---
  const cover = pack.addPage([A4_W, A4_H]);
  let y = A4_H - MARGIN - 20;
  cover.drawText("PRODUCTION DOCS — STUDY PACK", { x: MARGIN, y, size: 16, font: fontBold, color: ink });
  y -= 28;
  cover.drawText(`${product.code}`, { x: MARGIN, y, size: 22, font: fontBold, color: ink });
  y -= 20;
  cover.drawText(product.name || "", { x: MARGIN, y, size: 11, font, color: grey });
  y -= 14;
  cover.drawText(`Category: ${product.category}`, { x: MARGIN, y, size: 10, font, color: grey });
  y -= 28;
  cover.drawText("Contents", { x: MARGIN, y, size: 12, font: fontBold, color: ink });
  y -= 18;
  docs.forEach((d, i) => {
    if (y < MARGIN + 20) return; // index overflow — pages still follow
    cover.drawText(`${i + 1}.  ${d.categoryLabel}`, { x: MARGIN + 6, y, size: 10, font, color: ink });
    cover.drawText(d.filename, { x: MARGIN + 230, y, size: 9, font, color: grey });
    y -= 15;
  });

  // --- One section per doc ---
  for (const d of docs) {
    let bytes: ArrayBuffer | null = null;
    try {
      const res = await fetch(`/api/files/${d.id}/download`);
      if (res.ok) bytes = await res.arrayBuffer();
    } catch {
      bytes = null;
    }

    const ct = (d.contentType || "").toLowerCase();

    if (bytes && ct === "application/pdf") {
      try {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await pack.copyPages(src, src.getPageIndices());
        pages.forEach((p) => pack.addPage(p));
        continue;
      } catch {
        // fall through to placeholder
      }
    }

    if (bytes && (ct === "image/png" || ct === "image/jpeg" || ct === "image/jpg")) {
      try {
        const img = ct === "image/png" ? await pack.embedPng(bytes) : await pack.embedJpg(bytes);
        const page = pack.addPage([A4_W, A4_H]);
        page.drawText(d.categoryLabel, { x: MARGIN, y: A4_H - MARGIN, size: 11, font: fontBold, color: ink });
        page.drawText(d.filename, { x: MARGIN, y: A4_H - MARGIN - 14, size: 8, font, color: grey });
        const maxW = A4_W - MARGIN * 2;
        const maxH = A4_H - MARGIN * 2 - 30;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: (A4_W - w) / 2, y: (A4_H - h) / 2 - 15, width: w, height: h });
        continue;
      } catch {
        // fall through to placeholder
      }
    }

    // Placeholder for missing fetch or an un-embeddable type (webp/gif/heic).
    const page = pack.addPage([A4_W, A4_H]);
    page.drawText(d.categoryLabel, { x: MARGIN, y: A4_H - MARGIN, size: 11, font: fontBold, color: ink });
    page.drawText(d.filename, { x: MARGIN, y: A4_H - MARGIN - 16, size: 9, font, color: grey });
    page.drawText("This file type can't be embedded — open it from the product's Docs page.", {
      x: MARGIN, y: A4_H - MARGIN - 40, size: 9, font, color: grey,
    });
  }

  downloadBytes(await pack.save(), `${product.code.replace(/[^A-Za-z0-9._-]/g, "_")}-pack.pdf`);
}
