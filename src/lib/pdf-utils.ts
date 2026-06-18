// ============================================================
// HOOKKA ERP - Shared PDF Utility Functions
// ============================================================

import type jsPDF from "jspdf";
import logoDataUrl from "@/assets/hookka-logo.png?inline";
import { COMPANY, type CompanyCode } from "@/lib/constants";

const LOGO_ASPECT = 2038 / 907;

export function addHookkaLetterhead(
  doc: jsPDF,
  x: number,
  y: number,
  height: number = 11,
): void {
  const width = height * LOGO_ASPECT;
  doc.addImage(logoDataUrl, "PNG", x, y, width, height);
}

// ===========================================================================
// Shared premium document design system. EVERY generate-*-pdf.ts should
// build its header/footer/table off these so all company documents are
// visually identical and formal. Tune the look HERE → every doc updates.
// ===========================================================================

export const PDF = {
  margin: 14, // mm
  ink: [31, 29, 27] as [number, number, number], // primary text
  muted: [110, 110, 110] as [number, number, number], // secondary text
  faint: [150, 150, 150] as [number, number, number], // footer / fine print
  accent: [107, 92, 50] as [number, number, number], // #6B5C32 brand bronze
  rule: [210, 205, 198] as [number, number, number], // hairline grid
};

/**
 * Premium, formal letterhead shared by every document. Logo top-left, the
 * full registered company block beside it (single source of truth =
 * COMPANY constant), the document title + number block on the right, and a
 * fine rule finished with a thin bronze accent bar. Returns the Y (mm) the
 * caller should continue body content from.
 */
// A company's printed identity. COMPANY entries satisfy this; a sister company
// from the organisations registry (HOUZS, …) can be passed as `companyInfo`
// without being in the COMPANY constant.
export type LetterheadCompany = {
  name: string;
  regNo: string;
  tin: string;
  address: string;
  phone: string;
  email: string;
};

export function drawLetterhead(
  doc: jsPDF,
  opts: {
    docTitle: string;
    docNo: string;
    docDate?: string;
    statusText?: string;
    company?: CompanyCode;
    // Explicit identity override (sister companies / registry-resolved). Wins
    // over `company`. Lets every generator route its letterhead through this
    // one function instead of hand-rolling a company text block.
    companyInfo?: LetterheadCompany;
    // The bundled logo is HOOKKA's — pass false for sister-company prints
    // (OHANA/HOUZS) so we don't stamp the HOOKKA logo on their letterhead.
    logo?: boolean;
  },
): number {
  const co = opts.companyInfo ?? COMPANY[opts.company ?? "HOOKKA"];
  const m = PDF.margin;
  const pageW = doc.internal.pageSize.getWidth();
  const showLogo = opts.logo ?? true;

  // Logo (HOOKKA-branded docs only)
  const logoH = 13;
  if (showLogo) doc.addImage(logoDataUrl, "PNG", m, 12, logoH * LOGO_ASPECT, logoH);

  // Company block (beside the logo, or at the margin when there's no logo)
  const tx = showLogo ? m + logoH * LOGO_ASPECT + 5 : m;
  doc.setTextColor(...PDF.ink);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12.5);
  doc.text(co.name, tx, 16);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...PDF.muted);
  doc.text(`Reg. ${co.regNo}   |   TIN ${co.tin}`, tx, 21);
  doc.text(co.address, tx, 25);
  doc.text(`Tel ${co.phone}   |   ${co.email}`, tx, 29);

  // Document title block (right)
  doc.setTextColor(...PDF.accent);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(opts.docTitle.toUpperCase(), pageW - m, 17, { align: "right" });
  doc.setTextColor(...PDF.ink);
  doc.setFontSize(11);
  doc.text(opts.docNo, pageW - m, 24, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...PDF.muted);
  const meta: string[] = [];
  if (opts.docDate) meta.push(opts.docDate);
  if (opts.statusText) meta.push(opts.statusText);
  if (meta.length) doc.text(meta.join("   |   "), pageW - m, 29, { align: "right" });

  // Hairline + bronze accent bar
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.3);
  doc.line(m, 34, pageW - m, 34);
  doc.setFillColor(...PDF.accent);
  doc.rect(m, 34.6, pageW - m * 2, 0.8, "F");

  return 41;
}

/** Thin section label with an underline rule. Returns next Y. */
export function drawSectionLabel(
  doc: jsPDF,
  label: string,
  y: number,
): number {
  const m = PDF.margin;
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(...PDF.accent);
  doc.text(label.toUpperCase(), m, y);
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.3);
  doc.line(m, y + 1.6, pageW - m, y + 1.6);
  return y + 6;
}

/** Shared jspdf-autotable theme — solid bronze header, hairline grid. */
export function tableTheme(): {
  styles: Record<string, unknown>;
  headStyles: Record<string, unknown>;
  footStyles: Record<string, unknown>;
  alternateRowStyles: Record<string, unknown>;
} {
  return {
    styles: {
      font: "helvetica",
      fontSize: 7.5,
      cellPadding: 2.2,
      textColor: PDF.ink,
      lineColor: PDF.rule,
      lineWidth: 0.2,
      valign: "middle",
    },
    headStyles: {
      fillColor: PDF.accent,
      textColor: [255, 255, 255],
      fontSize: 7.5,
      fontStyle: "bold",
      lineColor: PDF.accent,
      lineWidth: 0.2,
      halign: "left",
    },
    footStyles: {
      fillColor: [245, 243, 239],
      textColor: PDF.ink,
      fontStyle: "bold",
      fontSize: 8,
      lineColor: PDF.rule,
      lineWidth: 0.2,
    },
    alternateRowStyles: { fillColor: [250, 249, 247] },
  };
}

/** Consistent footer on every document. */
export function drawDocFooter(
  doc: jsPDF,
  company?: CompanyCode,
): void {
  const co = COMPANY[company ?? "HOOKKA"];
  const m = PDF.margin;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const fy = pageH - 12;
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.3);
  doc.line(m, fy - 4, pageW - m, fy - 4);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.8);
  doc.setTextColor(...PDF.faint);
  doc.text(
    `${co.name} · ${co.regNo} · This is a computer-generated document; no signature required for system records.`,
    m,
    fy,
  );
  doc.text(
    `Generated ${new Date().toLocaleDateString("en-MY", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })}`,
    pageW - m,
    fy,
    { align: "right" },
  );
}

/**
 * Format sen amount as "1,234.56" (no RM prefix).
 */
export function fmtCurrency(sen: number): string {
  return (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format sen amount as "RM 1,234.56".
 */
export function fmtRM(sen: number): string {
  return `RM ${fmtCurrency(sen)}`;
}

/**
 * Format sen amount as plain number string "1,234.56" (no RM prefix, with thousands separator).
 */
export function fmtCurrencyPlain(sen: number): string {
  return (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format ISO date string as "16 Apr 2026".
 * Returns "-" for empty, null, undefined, or unparseable values so PDFs
 * never render a blank "Invalid Date" cell.
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Convert a whole number into English words.
 * e.g. 1234 -> "One Thousand Two Hundred and Thirty Four"
 */
export function numberToWords(amount: number): string {
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
  ];
  const tens = [
    "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
  ];

  if (amount === 0) return "Zero";

  function convertGroup(n: number): string {
    if (n === 0) return "";
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
    return ones[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " and " + convertGroup(n % 100) : "");
  }

  const parts: string[] = [];
  const units = ["", "Thousand", "Million", "Billion"];
  let remaining = Math.floor(amount);
  let unitIdx = 0;

  while (remaining > 0) {
    const group = remaining % 1000;
    if (group > 0) {
      const groupStr = convertGroup(group);
      parts.unshift(units[unitIdx] ? groupStr + " " + units[unitIdx] : groupStr);
    }
    remaining = Math.floor(remaining / 1000);
    unitIdx++;
  }

  return parts.join(" ");
}

/**
 * Convert sen amount to Malaysian Ringgit words for cheque / PDF display.
 * e.g. 123456 -> "Ringgit Malaysia One Thousand Two Hundred and Thirty Four and Fifty Six Sen Only"
 */
export function amountInWords(sen: number): string {
  const ringgit = Math.floor(Math.abs(sen) / 100);
  const cents = Math.abs(sen) % 100;
  if (ringgit === 0 && cents === 0) return "Ringgit Malaysia Zero Only";

  let result = "Ringgit Malaysia " + numberToWords(ringgit);
  if (cents > 0) {
    result += " and " + numberToWords(cents) + " Sen";
  }
  result += " Only";
  return result;
}
