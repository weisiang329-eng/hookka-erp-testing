// One-shot helper: render the REAL customer-notify templates with real DO
// data so the owner can preview the exact wording/layout in his own inbox.
// Run: node --import tsx/esm scripts/render-test-emails.mjs
// Writes JSON {dispatch:{subject,html,text}, invoice:{...}} to stdout.
import {
  dispatchNoticeTemplate,
  invoiceNoticeTemplate,
} from "../src/api/lib/customer-notify.ts";

const dispatch = dispatchNoticeTemplate({
  doNo: "DO-2606-028",
  customerName: "Houzs Century",
  customerPOIds: ["PO-008652"],
  dispatchedAt: "2026-06-11T09:56:12.190Z",
  deliverTo:
    "Houzs KL, 1831-B, JALAN KPB 1, KAWASAN PERINDUSTRIAN BALAKONG, SERI KEMBANGAN, SELANGOR.",
  itemsBreakdown: "3 x Sofa (5540 series)",
  hasAttachment: true,
  driverName: "JIVA",
  driverContact: "+6011-6133 3173",
  lorryPlate: null,
});

const invoice = invoiceNoticeTemplate({
  invoiceNo: "INV-2606-SAMPLE",
  invoiceDate: "2026-06-12T04:00:00.000Z",
  doNo: "DO-2606-028",
  customerName: "Houzs Century",
  customerPOIds: ["PO-008652"],
  deliveredAt: "2026-06-12T04:00:00.000Z",
  totalSen: 412500,
});

process.stdout.write(JSON.stringify({ dispatch, invoice }));
