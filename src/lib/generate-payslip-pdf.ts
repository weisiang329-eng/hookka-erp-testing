import type { PayslipDetail } from "@/lib/mock-data";

/**
 * Generate a printable payslip HTML for a single employee.
 * Opens in a new window for printing (browser Print → Save as PDF).
 */
export function generatePayslipHTML(
  payslip: PayslipDetail,
  ytd?: {
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
  }
): string {
  const fmt = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;
  const fmtRate = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;

  const periodLabel = (() => {
    const [y, m] = payslip.period.split("-");
    const months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    return `${months[parseInt(m) - 1]} ${y}`;
  })();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Payslip - ${payslip.employeeName} - ${periodLabel}</title>
  <style>
    @media print { body { margin: 0; } }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1F1D1B; padding: 20px; max-width: 800px; margin: 0 auto; }
    .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 12px; margin-bottom: 16px; }
    .header h1 { font-size: 18px; color: #000; margin-bottom: 2px; }
    .header p { font-size: 11px; color: #6B7280; }
    .header .title { font-size: 14px; font-weight: bold; margin-top: 8px; color: #1F1D1B; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin-bottom: 16px; padding: 10px; background: #fff; border: 1px solid #ddd; border-radius: 6px; }
    .info-grid .label { font-size: 10px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.5px; }
    .info-grid .value { font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #E2DDD8; }
    th { background: #f5f5f5; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #000; }
    td.amount { text-align: right; font-variant-numeric: tabular-nums; }
    th.amount { text-align: right; }
    .section-title { font-size: 12px; font-weight: 700; color: #000; margin: 12px 0 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    .total-row td { font-weight: 700; border-top: 2px solid #000; border-bottom: 2px solid #000; background: #f5f5f5; }
    .net-pay { font-size: 16px; font-weight: 700; text-align: center; padding: 12px; background: #f5f5f5; color: #000; border: 2px solid #000; border-radius: 6px; margin: 16px 0; }
    .formula { font-size: 10px; color: #6B7280; font-style: italic; }
    .footer { text-align: center; margin-top: 24px; padding-top: 12px; border-top: 1px solid #E2DDD8; font-size: 10px; color: #9CA3AF; }
    .ytd-section { margin-top: 16px; }
  </style>
</head>
<body>
  <div class="header">
    <img src="/hookka-logo.png" alt="Hookka 合家" style="height: 40px; width: auto; margin-bottom: 8px;" />
    <h1>HOOKKA INDUSTRIES SDN BHD</h1>
    <p>Co. Reg: 202301XXXXXX (XXXXXXX-X) | Lot XX, Jalan Perindustrian, 81700 Pasir Gudang, Johor</p>
    <div class="title">PAYSLIP - ${periodLabel.toUpperCase()}</div>
  </div>

  <div class="info-grid">
    <div><span class="label">Employee Name</span><div class="value">${payslip.employeeName}</div></div>
    <div><span class="label">Employee No</span><div class="value">${payslip.employeeNo}</div></div>
    <div><span class="label">Department</span><div class="value">${payslip.departmentCode.replace(/_/g, " ")}</div></div>
    <div><span class="label">Bank Account</span><div class="value">${payslip.bankAccount}</div></div>
    <div><span class="label">Working Days</span><div class="value">${payslip.workingDays} days</div></div>
    <div><span class="label">Pay Period</span><div class="value">${periodLabel}</div></div>
  </div>

  <div class="section-title">Earnings</div>
  <table>
    <thead>
      <tr><th>Description</th><th>Details</th><th class="amount">Amount (RM)</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>Basic Salary</td>
        <td class="formula">${payslip.workingDays} working days</td>
        <td class="amount">${fmt(payslip.basicSalary)}</td>
      </tr>
      <tr>
        <td>Weekday OT (1.5x)</td>
        <td class="formula">${payslip.otWeekdayHours} hrs x ${fmtRate(payslip.hourlyRate)}/hr x 1.5</td>
        <td class="amount">${payslip.otWeekdayHours > 0 ? fmt(payslip.otWeekdayAmount) : "-"}</td>
      </tr>
      <tr>
        <td>Sunday OT (2.0x)</td>
        <td class="formula">${payslip.otSundayHours} hrs x ${fmtRate(payslip.hourlyRate)}/hr x 2.0</td>
        <td class="amount">${payslip.otSundayHours > 0 ? fmt(payslip.otSundayAmount) : "-"}</td>
      </tr>
      <tr>
        <td>Public Holiday OT (3.0x)</td>
        <td class="formula">${payslip.otPHHours} hrs x ${fmtRate(payslip.hourlyRate)}/hr x 3.0</td>
        <td class="amount">${payslip.otPHHours > 0 ? fmt(payslip.otPHAmount) : "-"}</td>
      </tr>
      ${payslip.allowances > 0 ? `<tr><td>Allowances</td><td></td><td class="amount">${fmt(payslip.allowances)}</td></tr>` : ""}
      <tr class="total-row">
        <td colspan="2">GROSS PAY</td>
        <td class="amount">${fmt(payslip.grossPay)}</td>
      </tr>
    </tbody>
  </table>

  <div class="section-title">Deductions (Employee Portion)</div>
  <table>
    <thead>
      <tr><th>Description</th><th>Rate / Basis</th><th class="amount">Amount (RM)</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>EPF (Employee 11%)</td>
        <td class="formula">11% of ${fmt(payslip.basicSalary)} basic</td>
        <td class="amount">${fmt(payslip.epfEmployee)}</td>
      </tr>
      <tr>
        <td>SOCSO (Employee)</td>
        <td class="formula">Based on salary bracket</td>
        <td class="amount">${fmt(payslip.socsoEmployee)}</td>
      </tr>
      <tr>
        <td>EIS (Employee)</td>
        <td class="formula">Based on salary bracket</td>
        <td class="amount">${fmt(payslip.eisEmployee)}</td>
      </tr>
      <tr>
        <td>PCB (Tax Deduction)</td>
        <td class="formula">Monthly tax deduction</td>
        <td class="amount">${payslip.pcb > 0 ? fmt(payslip.pcb) : "-"}</td>
      </tr>
      <tr class="total-row">
        <td colspan="2">TOTAL DEDUCTIONS</td>
        <td class="amount">${fmt(payslip.totalDeductions)}</td>
      </tr>
    </tbody>
  </table>

  <div class="section-title">Employer Contributions (Not Deducted From Pay)</div>
  <table>
    <thead>
      <tr><th>Description</th><th>Rate / Basis</th><th class="amount">Amount (RM)</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>EPF (Employer 13%)</td>
        <td class="formula">13% of ${fmt(payslip.basicSalary)} basic</td>
        <td class="amount">${fmt(payslip.epfEmployer)}</td>
      </tr>
      <tr>
        <td>SOCSO (Employer)</td>
        <td class="formula">Based on salary bracket</td>
        <td class="amount">${fmt(payslip.socsoEmployer)}</td>
      </tr>
      <tr>
        <td>EIS (Employer)</td>
        <td class="formula">Based on salary bracket</td>
        <td class="amount">${fmt(payslip.eisEmployer)}</td>
      </tr>
    </tbody>
  </table>

  <div class="net-pay">
    NET PAY: ${fmt(payslip.netPay)}
  </div>

  <div class="formula" style="text-align:center; margin-bottom:12px;">
    Hourly Rate: ${fmt(payslip.basicSalary)} / (26 x 9) = ${fmtRate(payslip.hourlyRate)}/hr
  </div>

  ${ytd ? `
  <div class="ytd-section">
    <div class="section-title">Year-to-Date (YTD) Summary</div>
    <table>
      <thead>
        <tr><th>Item</th><th class="amount">YTD Amount (RM)</th></tr>
      </thead>
      <tbody>
        <tr><td>Basic Salary</td><td class="amount">${fmt(ytd.basicSalary)}</td></tr>
        <tr><td>Total OT</td><td class="amount">${fmt(ytd.totalOT)}</td></tr>
        <tr><td>Gross Pay</td><td class="amount">${fmt(ytd.grossPay)}</td></tr>
        <tr><td>EPF (Employee)</td><td class="amount">${fmt(ytd.epfEmployee)}</td></tr>
        <tr><td>EPF (Employer)</td><td class="amount">${fmt(ytd.epfEmployer)}</td></tr>
        <tr><td>SOCSO (Employee)</td><td class="amount">${fmt(ytd.socsoEmployee)}</td></tr>
        <tr><td>EIS (Employee)</td><td class="amount">${fmt(ytd.eisEmployee)}</td></tr>
        <tr><td>PCB</td><td class="amount">${fmt(ytd.pcb)}</td></tr>
        <tr><td>Total Deductions</td><td class="amount">${fmt(ytd.totalDeductions)}</td></tr>
        <tr class="total-row"><td>Net Pay</td><td class="amount">${fmt(ytd.netPay)}</td></tr>
      </tbody>
    </table>
  </div>
  ` : ""}

  <div class="footer">
    This is a computer-generated payslip. No signature is required.<br>
    Generated on ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "long", year: "numeric" })}
  </div>
</body>
</html>`;
}

/**
 * Open a new browser window with the payslip and trigger print dialog.
 */
export function printPayslip(
  payslip: PayslipDetail,
  ytd?: Parameters<typeof generatePayslipHTML>[1]
): void {
  const html = generatePayslipHTML(payslip, ytd);
  const printWindow = window.open("", "_blank");
  if (printWindow) {
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    // Give the new window time to lay out the document before invoking
    // print(). Runs from a print-button click handler in a plain utility
    // function — no React lifecycle, so useTimeout doesn't apply.
    // eslint-disable-next-line no-restricted-syntax -- non-React utility called from event handler
    setTimeout(() => printWindow.print(), 500);
  }
}
