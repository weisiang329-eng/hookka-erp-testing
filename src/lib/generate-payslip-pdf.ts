// ---------------------------------------------------------------------------
// The payslip document — ONE version, used everywhere (owner 2026-08-01:
// 「我们的payslip应该统一」). The office prints it from Payroll; the worker saves
// the same page from their phone once the month is APPROVED.
//
// It answers one question, in this order: what you are paid, and why it is not
// the full basic. Every reduction carries its formula AND the specific dates —
// that is what stops "你们乱算", because the worker can check the days against
// their own memory without asking anyone.
//
// Laid out the way a Malaysian payslip is expected to read: EARNINGS and
// DEDUCTIONS side by side, then the EMPLOYER'S CONTRIBUTION in its own box.
// Showing both halves of EPF / SOCSO / EIS is the local convention (owner
// 2026-08-01: 「马来西亚正常的payslip都是可以看到两个statutory的」) — an earlier
// draft folded the employer side into one sentence to save space, which is
// tidier but not what anyone here expects to see.
//
// No signature boxes: the owner does not collect signatures (「他们看而已」).
//
// Bilingual: pass `lang` and each money label prints the worker's language under
// the English. The workforce is Burmese and the worker app is already fully
// translated, so an English-only payslip fails the one job it has. Omit `lang`
// (or pass "en") for English only.
// ---------------------------------------------------------------------------
import type { PayslipDetail } from "@/types";
import { translateFor, type WorkerLang } from "@/lib/worker-i18n";
import { paymentMethodLabel, normalizePaymentMethod } from "@/lib/payment-method";

export type PayslipYTD = {
  basicSalary: number;
  totalOT: number;
  grossPay: number;
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  totalDeductions: number;
  netPay: number;
};

/**
 * Paper. NOT hard-coded, because "the payslip size" is a house convention, not
 * a standard — Malaysian payrolls run on A4, on A5, on half-A4 landscape and on
 * pre-printed carbonless pads, and the owner's is not A4 (2026-08-01:
 * 「马来西亚payslip size不一样的」). Sizes are in millimetres so a pad can be
 * matched exactly.
 */
export type PaperSize = "A4" | "A5" | "HALF_A4_LANDSCAPE" | { widthMm: number; heightMm: number };

const PAPER_MM: Record<string, { widthMm: number; heightMm: number }> = {
  A4: { widthMm: 210, heightMm: 297 },
  A5: { widthMm: 148, heightMm: 210 },
  HALF_A4_LANDSCAPE: { widthMm: 210, heightMm: 148 },
};

/** Millimetres → CSS pixels at the 96dpi browsers lay out print at. */
const mmToPx = (mm: number) => Math.round((mm / 25.4) * 96);

export type PayslipDocOptions = {
  /** Second language printed under each money label. Omit for English only. */
  lang?: WorkerLang;
  /** Company block. Defaults to Hookka's registered details. */
  company?: { name: string; reg?: string; address?: string };
  /** Paper to lay out for. Defaults to A4. */
  paper?: PaperSize;
  /** Page margin in millimetres. Defaults to 12. */
  marginMm?: number;
};

/** The optional day-detail the API attaches. Each block simply does not render
 *  when its figure is absent, so an older stored row still produces a valid
 *  document rather than a broken one. */
export type PayslipDocData = PayslipDetail & {
  absentDays?: number;
  absenceDeductionSen?: number;
  shortHourDeductionSen?: number;
  absentDates?: string[];
  lateDays?: Array<{ date: string; hours: number }>;
  otDays?: Array<{ date: string; hours: number }>;
  paymentMethod?: string;
  bankName?: string;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** "2026-07" → "July 2026". */
function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period ?? "");
  if (!m) return period ?? "";
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "2026-07-14" → "14 Jul". Day chips are scanned, not read. */
function dayChipLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return iso ?? "";
  return `${Number(m[3])} ${(MONTHS[Number(m[2]) - 1] ?? "").slice(0, 3)}`;
}

const money = (sen: number) =>
  ((Number(sen) || 0) / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function generatePayslipHTML(
  payslip: PayslipDocData,
  ytd?: PayslipYTD,
  opts: PayslipDocOptions = {},
): string {
  const lang = opts.lang && opts.lang !== "en" ? opts.lang : null;
  const L = (en: string, key?: string) =>
    lang && key
      ? `${esc(en)}<span class="alt">${esc(translateFor(lang, key))}</span>`
      : esc(en);

  // Preview must equal print. The sheet used to be 794px wide (A4) PLUS its own
  // padding, while @page added a 14mm margin on top — so what the operator saw
  // on screen was ~6% wider than what came out of the printer, and a column
  // that just fitted on screen could wrap on paper. The page margin is now the
  // sheet's padding, so the two are the same box.
  const paper =
    typeof opts.paper === "object"
      ? opts.paper
      : PAPER_MM[opts.paper ?? "A4"] ?? PAPER_MM.A4;
  const marginMm = opts.marginMm ?? 12;
  const sheetW = mmToPx(paper.widthMm);
  const padPx = mmToPx(marginMm);
  const pageSize =
    typeof opts.paper === "object" || !opts.paper || !(opts.paper in PAPER_MM)
      ? `${paper.widthMm}mm ${paper.heightMm}mm`
      : paper.widthMm > paper.heightMm
        ? `${opts.paper === "HALF_A4_LANDSCAPE" ? "A5" : opts.paper} landscape`
        : String(opts.paper);

  const co = opts.company ?? {
    name: "HOOKKA INDUSTRIES SDN BHD",
    reg: "202301XXXXXX",
    address: "Lot XX, Jalan Perindustrian, 81700 Pasir Gudang, Johor",
  };

  const absentDays = Number(payslip.absentDays) || 0;
  const absenceSen = Number(payslip.absenceDeductionSen) || 0;
  const shortSen = Number(payslip.shortHourDeductionSen) || 0;
  const lateDays = payslip.lateDays ?? [];
  const shortHours =
    Math.round(lateDays.reduce((s, d) => s + (Number(d.hours) || 0), 0) * 100) / 100;
  const otDays = payslip.otDays ?? [];
  const employerSen =
    (payslip.epfEmployer || 0) + (payslip.socsoEmployer || 0) + (payslip.eisEmployer || 0);
  const isCash = normalizePaymentMethod(payslip.paymentMethod) === "CASH";

  const chips = (items: string[], cls = "") =>
    items.length
      ? `<div class="days">${items.map((t) => `<span class="chip ${cls}">${esc(t)}</span>`).join("")}</div>`
      : "";

  // EARNINGS — the money side only. Every reduction that is NOT statutory
  // (absence, late/short) belongs here too, because it is what makes Gross
  // differ from the basic; its WORKING is spelled out below the tables so the
  // columns stay readable.
  const earningRows: string[] = [];
  const detail: string[] = [];
  earningRows.push(`<tr>
    <td>${L("Basic salary", "pay.fullSalary")}</td>
    <td class="num">${money(payslip.basicSalary)}</td>
  </tr>`);

  if (absenceSen > 0) {
    earningRows.push(`<tr>
      <td class="neg">${L("Less — Absence", "pay.absence")} (${absentDays}${absentDays === 1 ? " day" : " days"})</td>
      <td class="num neg">(${money(absenceSen)})</td>
    </tr>`);
    detail.push(`<div class="why">
      <b>Absence</b> &nbsp; ${money(payslip.basicSalary)} &divide; ${esc(payslip.workingDays)} days &times; ${absentDays} = ${money(absenceSen)}
      ${chips((payslip.absentDates ?? []).map(dayChipLabel))}
    </div>`);
  }

  if (shortSen > 0) {
    const rate = shortHours > 0 ? money(Math.round(shortSen / shortHours)) : "";
    earningRows.push(`<tr>
      <td class="neg">${L("Less — Late / short hours", "pay.lateShortDeduction")} (${shortHours} h)</td>
      <td class="num neg">(${money(shortSen)})</td>
    </tr>`);
    detail.push(`<div class="why">
      <b>Late / short hours</b> &nbsp; ${shortHours} h${rate ? ` &times; RM ${rate}/h` : ""} = ${money(shortSen)}
      <span class="rule-note">10-minute grace, then charged in 15-minute blocks</span>
      ${chips(lateDays.map((d) => `${dayChipLabel(d.date)} — ${d.hours} h`), "late")}
    </div>`);
  }

  const otHrs =
    (payslip.otWeekdayHours || 0) + (payslip.otSundayHours || 0) + (payslip.otPHHours || 0);
  earningRows.push(`<tr>
    <td>${L("Overtime", "pay.ot")} (${otHrs} h)</td>
    <td class="num">${money(payslip.totalOT)}</td>
  </tr>`);
  detail.push(`<div class="why">
    <b>Overtime</b> &nbsp; ${otHrs} h = ${money(payslip.totalOT)}
    <span class="rule-note">Counted only after 18:00, and only once it reaches 30 minutes</span>
    ${chips(otDays.map((d) => `${dayChipLabel(d.date)} — ${d.hours} h`), "ot")}
  </div>`);

  if ((payslip.allowances || 0) > 0) {
    earningRows.push(`<tr>
      <td>${L("Allowance", "pay.efficiencyAllowance")}</td>
      <td class="num">${money(payslip.allowances)}</td>
    </tr>`);
  }

  const deductionDetail = detail.length
    ? `<h2>How the deductions were worked out</h2>${detail.join("\n")}`
    : "";

  // A DRAFT month is an estimate and must say so on its face — a worker who
  // saves one mid-month should never mistake it for the final figure.
  const statusStamp =
    payslip.status === "DRAFT"
      ? `<div class="stamp draft">ESTIMATE — NOT FINAL</div>`
      : `<div class="stamp">${esc(payslip.status)}</div>`;

  const ytdBlock = ytd
    ? `<h2>Year to date</h2>
       <table>
         <tr>
           <td>Gross pay</td><td class="num">${money(ytd.grossPay)}</td>
           <td>Total deductions</td><td class="num">(${money(ytd.totalDeductions)})</td>
           <td>Net pay</td><td class="num"><b>${money(ytd.netPay)}</b></td>
         </tr>
       </table>`
    : "";

  return `<!DOCTYPE html>
<html lang="${esc(opts.lang ?? "en")}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payslip — ${esc(payslip.employeeName)} — ${esc(periodLabel(payslip.period))}</title>
<style>
  :root{--ink:#1F1D1B;--mut:#6B7280;--line:#E2DDD8;--gold:#6B5C32;--red:#9A3A2D}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#EFECE8;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);padding:20px}
  .sheet{width:${sheetW}px;max-width:100%;margin:0 auto;background:#fff;padding:${padPx}px;box-shadow:0 2px 14px rgba(0,0,0,.09)}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:2px solid var(--ink);padding-bottom:12px}
  .brand{font-size:17px;font-weight:800;letter-spacing:2.5px}
  .co{font-size:9.5px;color:var(--mut);margin-top:3px;line-height:1.45}
  .docmeta{text-align:right;white-space:nowrap}
  .doctitle{font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase}
  .docsub{font-size:10px;color:var(--mut);margin-top:3px}
  .stamp{display:inline-block;margin-top:6px;padding:2px 9px;border:1px solid #4F7C3A;border-radius:3px;color:#4F7C3A;font-size:9px;font-weight:700;letter-spacing:1px}
  .stamp.draft{border-color:#9C6F1E;color:#9C6F1E}
  .who{display:grid;grid-template-columns:1fr 1fr;gap:0 26px;margin:16px 0 6px}
  .f{display:flex;gap:8px;padding:3px 0;font-size:11px;border-bottom:1px dotted #EDE8E3}
  .f .k{color:var(--mut);min-width:104px}
  .f .v{font-weight:600}
  h2{font-size:9.5px;letter-spacing:1.4px;color:var(--gold);text-transform:uppercase;margin:16px 0 6px;padding-bottom:3px;border-bottom:1px solid var(--line)}
  table{width:100%;border-collapse:collapse}
  td,th{padding:4px 0;font-size:11.5px;vertical-align:top}
  th{font-size:9px;letter-spacing:.8px;color:var(--mut);text-transform:uppercase;text-align:left;font-weight:600}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .neg{color:var(--red)}
  .sub{font-size:9.5px;color:var(--mut);padding-left:10px}
  .rule td{border-top:1px solid var(--line);padding-top:6px;font-weight:700}
  .alt{display:block;font-size:9.5px;color:var(--mut);font-weight:400;line-height:1.35}
  .days{margin-top:3px}
  .chip{display:inline-block;font-size:9px;padding:1px 6px;margin:2px 3px 0 0;border-radius:3px;background:#F5EFEA;color:#7A5C48}
  .chip.late{background:#FBEAE7;color:var(--red)}
  .chip.ot{background:#FBF3DA;color:#8A6D1F}
  .net{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding:12px 16px;background:var(--ink);color:#fff;border-radius:3px;gap:16px}
  .net .l{font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:.8}
  .net .l .alt{color:#D8D2CC;letter-spacing:0;text-transform:none}
  .net .v{font-size:23px;font-weight:800;font-variant-numeric:tabular-nums}
  .er{margin-top:6px;font-size:9.5px;color:var(--mut);line-height:1.45;font-style:italic}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:0 28px;align-items:start}
  .why{margin:6px 0 10px;font-size:10.5px;color:#4B5563;padding-left:10px;border-left:2px solid var(--line)}
  .why b{color:var(--ink)}
  .rule-note{display:block;font-size:9.5px;color:var(--mut);margin-top:1px}
  .foot{margin-top:20px;padding-top:9px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;font-size:9px;color:#9CA3AF}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;width:auto;padding:0}@page{size:${pageSize};margin:${marginMm}mm}}
  @media (max-width:560px){
    body{padding:10px}
    .sheet{padding:18px 16px}
    .top{flex-direction:column}
    .two{grid-template-columns:1fr;gap:0}
    .who{grid-template-columns:1fr}
    .docmeta{text-align:left}
    .net .v{font-size:20px}
  }
</style>
</head>
<body>
<div class="sheet">
  <div class="top">
    <div>
      <div class="brand">HOOKKA 合家</div>
      <div class="co">${esc(co.name)}${co.reg ? ` &nbsp;(${esc(co.reg)})` : ""}${co.address ? `<br>${esc(co.address)}` : ""}</div>
    </div>
    <div class="docmeta">
      <div class="doctitle">Payslip</div>
      <div class="docsub">${esc(periodLabel(payslip.period))}</div>
      ${statusStamp}
    </div>
  </div>

  <div class="who">
    <div>
      <div class="f"><span class="k">Employee</span><span class="v">${esc(payslip.employeeName)}</span></div>
      <div class="f"><span class="k">Employee No</span><span class="v">${esc(payslip.employeeNo)}</span></div>
      <div class="f"><span class="k">Department</span><span class="v">${esc((payslip.departmentCode || "").replace(/_/g, " "))}</span></div>
    </div>
    <div>
      <div class="f"><span class="k">Payment method</span><span class="v">${esc(paymentMethodLabel(payslip.paymentMethod))}</span></div>
      ${
        isCash
          ? ""
          : `<div class="f"><span class="k">Bank</span><span class="v">${esc(payslip.bankName || "—")}</span></div>
             <div class="f"><span class="k">Account no.</span><span class="v">${esc(payslip.bankAccount || "Not set")}</span></div>`
      }
    </div>
  </div>

  <div class="two">
    <div>
      <h2>Earnings</h2>
      <table>
        <tr><th style="width:62%">Description</th><th class="num">Amount (RM)</th></tr>
        ${earningRows.join("\n")}
        <tr class="rule"><td>Gross pay</td><td class="num">${money(payslip.grossPay)}</td></tr>
      </table>
    </div>
    <div>
      <h2>Deductions</h2>
      <table>
        <tr><th style="width:62%">Description</th><th class="num">Amount (RM)</th></tr>
        <tr><td>EPF (employee)</td><td class="num">${money(payslip.epfEmployee)}</td></tr>
        <tr><td>SOCSO (employee)</td><td class="num">${money(payslip.socsoEmployee)}</td></tr>
        <tr><td>EIS (employee)</td><td class="num">${money(payslip.eisEmployee)}</td></tr>
        <tr><td>PCB (income tax)</td><td class="num">${money(payslip.pcb)}</td></tr>
        <tr class="rule"><td>Total deductions</td><td class="num">${money(payslip.totalDeductions)}</td></tr>
      </table>

      <h2>Employer&rsquo;s contribution</h2>
      <table>
        <tr><td>EPF (employer)</td><td class="num">${money(payslip.epfEmployer)}</td></tr>
        <tr><td>SOCSO (employer)</td><td class="num">${money(payslip.socsoEmployer)}</td></tr>
        <tr><td>EIS (employer)</td><td class="num">${money(payslip.eisEmployer)}</td></tr>
        <tr class="rule"><td>Total</td><td class="num">${money(employerSen)}</td></tr>
      </table>
      <p class="er">Paid by the company on your behalf &mdash; not deducted from your pay.</p>
    </div>
  </div>

  ${deductionDetail}

  <div class="net">
    <span class="l">Net pay${lang ? `<span class="alt">${esc(translateFor(lang, "pay.thisMonth"))}</span>` : ""}</span>
    <span class="v">RM ${money(payslip.netPay)}</span>
  </div>

  ${ytdBlock}

  <div class="foot">
    <span>Hookka ERP</span>
    <span>Questions about this payslip? Speak to the office.</span>
  </div>
</div>
</body>
</html>`;
}
