import { writeFileSync } from "node:fs";
import { generatePayslipHTML } from "./src/lib/generate-payslip-pdf.ts";
// ANN's real 2026-07 figures.
const ann = {
  id:"x", employeeId:"w", employeeName:"ANN", employeeNo:"EMP-004", departmentCode:"FAB_SEW",
  period:"2026-07", basicSalary:265000, workingDays:26,
  otWeekdayHours:0, otSundayHours:0, otPHHours:0, hourlyRate:1199,
  otWeekdayAmount:0, otSundayAmount:0, otPHAmount:0, totalOT:0, allowances:0,
  grossPay:212263, epfEmployee:29150, epfEmployer:34450, socsoEmployee:745,
  socsoEmployer:2615, eisEmployee:390, eisEmployer:390, pcb:0,
  totalDeductions:30285, netPay:181978, bankAccount:"8001234567", status:"APPROVED",
  absentDays:5, absenceDeductionSen:50962, shortHourDeductionSen:1775,
  absentDates:["2026-07-14","2026-07-28","2026-07-29","2026-07-30","2026-07-31"],
  lateDays:[{date:"2026-07-25",hours:1.48}], otDays:[],
  paymentMethod:"TRANSFER", bankName:"CIMB Bank",
};
writeFileSync("/tmp/payslip-final.html", generatePayslipHTML(ann, undefined, { lang: "my" }));
console.log("ok");
