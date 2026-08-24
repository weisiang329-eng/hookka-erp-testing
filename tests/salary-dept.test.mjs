import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/salary-dept.ts")).href);

test("groups payslip rows by month and department, cost = gross + employer statutory", () => {
  const out = m.groupPayslipsByMonthDept([
    { period: "2026-07", departmentCode: "FAB_CUT", grossPaySen: 100000, epfEmployerSen: 13000, socsoEmployerSen: 1700, eisEmployerSen: 200 },
    { period: "2026-07", departmentCode: "FAB_CUT", gross_pay_sen: 50000, epf_employer_sen: 6500, socso_employer_sen: 850, eis_employer_sen: 100 },
    { period: "2026-07", departmentCode: "FOAM", grossPaySen: 30000, epfEmployerSen: 0, socsoEmployerSen: 0, eisEmployerSen: 0 },
    { period: "2026-06", departmentCode: "FOAM", grossPaySen: 10000, epfEmployerSen: 0, socsoEmployerSen: 0, eisEmployerSen: 0 },
  ]);
  assert.deepEqual(out.get("2026-07"), [
    { dept: "FAB_CUT", costSen: 172350 },
    { dept: "FOAM", costSen: 30000 },
  ]);
  assert.deepEqual(out.get("2026-06"), [{ dept: "FOAM", costSen: 10000 }]);
});

test("blank department lands in (unassigned); bad periods are dropped", () => {
  const out = m.groupPayslipsByMonthDept([
    { period: "2026-07", departmentCode: "", grossPaySen: 1000, epfEmployerSen: 0, socsoEmployerSen: 0, eisEmployerSen: 0 },
    { period: "garbage", departmentCode: "FOAM", grossPaySen: 999, epfEmployerSen: 0, socsoEmployerSen: 0, eisEmployerSen: 0 },
  ]);
  assert.deepEqual(out.get("2026-07"), [{ dept: "(unassigned)", costSen: 1000 }]);
  assert.equal(out.size, 1);
});

test("labourMappedAccounts collects dept accounts + fallback + statutory, deduped sorted", () => {
  assert.deepEqual(
    m.labourMappedAccounts({
      fallback: "750-0010",
      byDept: { MAINTENANCE: "780-0030", WAREHOUSING: "780-0000", OFFICE: "900-S002", DUP: "780-0030" },
      epf: "750-0020", socso: "750-0030", eis: "750-0040",
    }),
    ["750-0010", "750-0020", "750-0030", "750-0040", "780-0000", "780-0030", "900-S002"],
  );
  assert.deepEqual(m.labourMappedAccounts({}), []);
});

test("supersede rule: any dept: key disables labour-account entries for that month", () => {
  assert.equal(m.monthHasDeptForecast({ "dept:FAB_CUT": { bp: 500 } }), true);
  assert.equal(m.monthHasDeptForecast({ "750-0010": { bp: 500 } }), false);
  assert.equal(m.monthHasDeptForecast(undefined), false);
  assert.equal(m.forecastEntryKind("dept:FAB_CUT"), "dept");
  assert.equal(m.forecastEntryKind("750-0010"), "labourAccount");
  assert.equal(m.forecastEntryKind("750-0040"), "labourAccount");
  assert.equal(m.forecastEntryKind("900-S002"), "other");
  assert.equal(m.forecastEntryKind("cat:FABRIC"), "other");
});
