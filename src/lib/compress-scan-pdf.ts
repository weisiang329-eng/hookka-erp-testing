// ---------------------------------------------------------------------------
// Client-side compression for SCAN uploads (supplier PI / GRN / SO documents).
//
// A supplier "Purchase Invoice" the operator scans is often a 10-30 MB stack
// of HIGH-RESOLUTION scanned images (~400 KB+ per page). Sent as-is, the AI's
// boundary-detection step — which must read the WHOLE PDF to split it into one
// document per invoice — chokes on the payload and stalls: the operator sees
// "Reading 1 document… scanning" forever and it never splits into the N
// invoices (owner report 2026-06-30: a 31-page / 12.6 MB PDF of 13 PIs).
//
// OCR of invoice text only needs ~150 DPI, so we re-render each page to a
// compact JPEG before upload. Result: typically 5-8x smaller → the upload is
// fast AND the AI split + per-invoice OCR actually run (and stream in, in page
// order). Falls back to the ORIGINAL file on any error — compression must
// never block a scan.
// ---------------------------------------------------------------------------

const COMPRESS_MIN_BYTES = 2 * 1024 * 1024; // < 2 MB: upload + scan fine as-is
const TARGET_LONG_PX = 1800; // ~150 DPI for an A4 page — readable for OCR, compact
const JPEG_QUALITY = 0.7;

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/jpeg",
      quality,
    );
  });
}

async function compressPdf(file: File): Promise<File> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const { PDFDocument } = await import("pdf-lib");

  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const out = await PDFDocument.create();

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const longSide = Math.max(base.width, base.height);
    // Scale the long side toward TARGET_LONG_PX; never upscale wildly (cap 2.5x)
    // and never shrink below 0.4x.
    const scale = Math.max(0.4, Math.min(2.5, TARGET_LONG_PX / longSide));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas context");
    // White matte so a transparent source doesn't render black in JPEG.
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    const jpeg = await canvasToJpeg(canvas, JPEG_QUALITY);
    const jpegBytes = new Uint8Array(await jpeg.arrayBuffer());
    const img = await out.embedJpg(jpegBytes);
    const pg = out.addPage([img.width, img.height]);
    pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

    // Release the canvas between pages so a long PDF doesn't pile up memory.
    canvas.width = 0;
    canvas.height = 0;
  }

  const bytes = await out.save();
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new File([ab], file.name, { type: "application/pdf" });
}

async function compressImage(file: File): Promise<File> {
  const bmp = await createImageBitmap(file);
  const longSide = Math.max(bmp.width, bmp.height);
  const scale = Math.min(1, TARGET_LONG_PX / longSide); // never upscale a photo
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const jpeg = await canvasToJpeg(canvas, JPEG_QUALITY);
  const ab = await jpeg.arrayBuffer();
  const newName = file.name.replace(/\.(png|webp|jpe?g)$/i, "") + ".jpg";
  return new File([ab], newName, { type: "image/jpeg" });
}

/**
 * Compress a heavy scanned PDF/image before upload. Returns the original file
 * unchanged when it's already small, isn't a PDF/image, the result would be
 * bigger, or anything throws — so a scan is NEVER blocked by compression.
 */
export async function compressScanFile(file: File): Promise<File> {
  if (file.size < COMPRESS_MIN_BYTES) return file;
  try {
    const isPdf =
      file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isImage =
      file.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!isPdf && !isImage) return file;
    const compressed = isPdf ? await compressPdf(file) : await compressImage(file);
    // Only keep it if we actually saved space.
    return compressed.size < file.size ? compressed : file;
  } catch {
    return file; // best-effort — fall back to the original on any failure
  }
}
