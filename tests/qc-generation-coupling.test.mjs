// ---------------------------------------------------------------------------
// QC slot generation follows the three DIFFERENT rhythms the owner described
// (2026-08-08), and inspection numbers stay unique.
//
//   RM  — one inspection per GOODS RECEIPT per material family on it.
//         "只要有了 GR … 我们只需要检查一次 … 每一 batch 进来都必须抽检".
//         The 2026-08-07 day gate got this wrong in the most damaging
//         direction: two receipts on one day collapsed into ONE inspection,
//         and the slot named no receipt at all, so the inspector could not
//         tell which goods they were supposed to be looking at.
//   WIP — twice daily, gated on the department actually working. Unchanged.
//   FG  — a sampled SHARE of the units produced, each slot bound to one unit
//         and its sales-order line, because "有没有做对 order" is not a
//         question you can answer against a template.
//
// Historical context for the two defects this file already guarded (both fixed
// 2026-08-07, both still guarded below): generation used to be a blind schedule
// (34 rows a day forever → a 3,009-row backlog nobody could clear), and
// inspectionNo used to COLLIDE because a COUNT(*) ran inside a loop whose
// INSERTs were all deferred to one db.batch().
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { generatePendingForSlot, fgSampleTarget } from "../src/api/routes/qc-pending.ts";

const SLOT = "2026-08-07T04:00:00.000Z"; // 12:00 local (UTC+8)
const SLOT_2 = "2026-08-07T08:00:00.000Z"; // 16:00 local, same day
const SLOT_DATE = "2026-08-07";

function makeDb({
  templates = [],
  templateItems = [],
  jobCards = [],
  grns = [],
  grnItems = [],
  rawMaterials = [],
  fgUnits = [],
  inspections = [],
} = {}) {
  const state = { inspections, inspectionItems: [], ddl: [] };
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  function exec(rawSql, args) {
    const s = norm(rawSql);

    // Runtime schema self-apply — a migration file alone is inert, so
    // generation issues its own ALTERs. They are no-ops here.
    if (/^(ALTER TABLE|CREATE INDEX)/i.test(s)) {
      state.ddl.push(s);
      return { rows: [] };
    }

    if (/^SELECT \* FROM qc_templates WHERE active = 1$/i.test(s)) {
      return { rows: templates.filter((t) => t.active === 1).map((t) => ({ ...t })) };
    }
    if (/^SELECT \* FROM qc_template_items$/i.test(s)) {
      return { rows: templateItems.map((t) => ({ ...t })) };
    }
    if (/^SELECT templateId FROM qc_inspections WHERE scheduledSlotAt = \?$/i.test(s)) {
      return {
        rows: state.inspections
          .filter((r) => r.scheduledSlotAt === args[0])
          .map((r) => ({ templateId: r.templateId })),
      };
    }
    if (/^SELECT inspectionNo FROM qc_inspections WHERE inspectionNo LIKE \?$/i.test(s)) {
      const pfx = args[0].replace(/%$/, "");
      return {
        rows: state.inspections
          .filter((r) => (r.inspectionNo ?? "").startsWith(pfx))
          .map((r) => ({ inspectionNo: r.inspectionNo })),
      };
    }

    // --- the WIP activity probe ---
    if (/^SELECT 1 AS hit FROM job_cards/i.test(s)) {
      const [dept, date] = args;
      const hit = jobCards.some(
        (j) =>
          j.departmentCode === dept &&
          (["IN_PROGRESS", "PAUSED"].includes(j.status) || j.completedDate === date),
      );
      return { rows: hit ? [{ hit: 1 }] : [] };
    }

    // --- RM: the receipt scan ---
    if (/^SELECT id, grnNumber, supplierId, supplierName, receiveDate FROM grns/i.test(s)) {
      const [from, to] = args;
      return {
        rows: grns
          .filter(
            (g) =>
              ["CONFIRMED", "POSTED"].includes(g.status) &&
              (g.receiveDate ?? "") >= from &&
              (g.receiveDate ?? "") <= to,
          )
          .map((g) => ({ ...g })),
      };
    }
    if (/FROM grn_items gitem/i.test(s)) {
      const ids = new Set(args);
      return {
        rows: grnItems
          .filter((li) => ids.has(li.grnId))
          .map((li) => ({
            grnId: li.grnId,
            materialCode: li.materialCode ?? null,
            materialName: li.materialName ?? null,
            itemGroup:
              rawMaterials.find(
                (rm) =>
                  String(rm.itemCode ?? "").toUpperCase() ===
                  String(li.materialCode ?? "").toUpperCase(),
              )?.itemGroup ?? null,
          })),
      };
    }
    if (/FROM qc_inspections WHERE source_grn_id IN/i.test(s)) {
      const ids = new Set(args);
      return {
        rows: state.inspections
          .filter((r) => r.sourceGrnId && ids.has(r.sourceGrnId))
          .map((r) => ({ grnId: r.sourceGrnId, templateId: r.templateId })),
      };
    }

    // --- FG: units produced today, joined to their SO line ---
    if (/FROM fg_units fgu/i.test(s)) {
      const pfx = args[0].replace(/%$/, "");
      return {
        rows: fgUnits
          .filter((u) => (u.mfdDate ?? "").startsWith(pfx) || (u.packedAt ?? "").startsWith(pfx))
          .map((u) => ({ unitId: u.id, ...u }))
          .sort((a, b) => String(a.unitId).localeCompare(String(b.unitId))),
      };
    }
    if (/FROM qc_inspections WHERE source_fg_unit_id IS NOT NULL/i.test(s)) {
      return {
        rows: state.inspections
          .filter((r) => r.sourceFgUnitId && r.inspectionDate === args[0])
          .map((r) => ({ unitId: r.sourceFgUnitId })),
      };
    }

    if (/^INSERT INTO qc_inspections/i.test(s)) {
      const [id, inspectionNo, templateId, templateSnapshot, stage, itemCategory,
        department, scheduledSlotAt, inspectionDate, createdAt,
        subjectType, subjectId, subjectLabel,
        sourceGrnId, sourceGrnNo, materialFamily, sourceFgUnitId, soSpec] = args;
      state.inspections.push({
        id, inspectionNo, templateId, templateSnapshot, stage, itemCategory,
        department, scheduledSlotAt, inspectionDate, createdAt,
        subjectType, subjectId, subjectLabel,
        sourceGrnId, sourceGrnNo, materialFamily, sourceFgUnitId, soSpec,
        triggerType: "SCHEDULED", status: "PENDING",
      });
      return { rows: [] };
    }
    if (/^INSERT INTO qc_inspection_items/i.test(s)) {
      state.inspectionItems.push(args);
      return { rows: [] };
    }

    throw new Error(`unexpected SQL: ${s}`);
  }

  const DB = {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...a) { bound = a; stmt._bound = a; return stmt; },
        async run() { exec(sql, bound); return { success: true }; },
        async first() { return exec(sql, bound).rows[0] ?? null; },
        async all() { return { results: exec(sql, bound).rows }; },
        _run() { return exec(sql, stmt._bound ?? []); },
      };
      return stmt;
    },
    async batch(stmts) { return stmts.map((s) => { s._run(); return { success: true }; }); },
  };

  return { DB, state };
}

function tpl(over) {
  return {
    id: "t?", name: "Checklist", deptCode: "FAB_SEW", deptName: "Fabric Sewing",
    itemCategory: "SOFA", stage: "WIP", active: 1, notes: null, materialFamily: null, ...over,
  };
}
function tplItem(templateId, seq) {
  return {
    id: `ti-${templateId}-${seq}`, templateId, sequence: seq,
    itemName: `Check ${seq}`, criteria: null, severity: "MAJOR", isMandatory: 1,
  };
}
function rmTpl(id, family) {
  return tpl({ id, stage: "RM", deptCode: "WAREHOUSING", itemCategory: "GENERAL", materialFamily: family });
}

// The four RM templates a realistic fixture needs, plus the fallback.
const RM_TEMPLATES = [
  rmTpl("qct-rm-fabric", "FABRIC"),
  rmTpl("qct-rm-wood", "TIMBER"),
  rmTpl("qct-rm-plywood", "PLYWOOD"),
  rmTpl("qct-rm-general", "GENERAL"),
];
const RM_TEMPLATE_ITEMS = RM_TEMPLATES.map((t) => tplItem(t.id, 1));
const RAW_MATERIALS = [
  { itemCode: "FAB-001", itemGroup: "S.M-FABR" },
  { itemCode: "FAB-002", itemGroup: "B.M-FABR" },
  { itemCode: "WD-001", itemGroup: "B.OTHERS", },
  { itemCode: "PLY-001", itemGroup: "PLYWOOD" },
];

// ── RM: the unit is the RECEIPT ─────────────────────────────────────────────

test("two goods receipts on the SAME DAY raise two RM inspections", async () => {
  // This is the behaviour the day gate got wrong. Under the old rule these two
  // receipts shared one "RM had activity today" slot, so one of them was never
  // inspected at all — the opposite of 每一 batch 进来都必须抽检.
  const db = makeDb({
    templates: RM_TEMPLATES,
    templateItems: RM_TEMPLATE_ITEMS,
    rawMaterials: RAW_MATERIALS,
    grns: [
      { id: "grn-1", grnNumber: "GRN-0001", supplierId: "sup-a", supplierName: "Add Wood", receiveDate: SLOT_DATE, status: "POSTED" },
      { id: "grn-2", grnNumber: "GRN-0002", supplierId: "sup-b", supplierName: "Fabric Co", receiveDate: SLOT_DATE, status: "CONFIRMED" },
    ],
    grnItems: [
      { grnId: "grn-1", materialCode: "WD-001", materialName: "Wood strip 2x2" },
      { grnId: "grn-2", materialCode: "FAB-001", materialName: "Sofa fabric grey" },
    ],
  });

  const res = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(res.rmCreated, 2, "one receipt, one inspection — two receipts must be two");
  assert.equal(res.rmReceipts, 2);
  assert.deepEqual(
    db.state.inspections.map((r) => r.sourceGrnNo).sort(),
    ["GRN-0001", "GRN-0002"],
  );
});

test("one goods receipt raises ONE inspection however many lines it has", async () => {
  const db = makeDb({
    templates: RM_TEMPLATES,
    templateItems: RM_TEMPLATE_ITEMS,
    rawMaterials: RAW_MATERIALS,
    grns: [{ id: "grn-1", grnNumber: "GRN-0001", supplierId: "sup-b", supplierName: "Fabric Co", receiveDate: SLOT_DATE, status: "POSTED" }],
    // Six lines, all fabric — one delivery of fabric is one inspection.
    grnItems: [
      { grnId: "grn-1", materialCode: "FAB-001", materialName: "Grey" },
      { grnId: "grn-1", materialCode: "FAB-001", materialName: "Grey" },
      { grnId: "grn-1", materialCode: "FAB-002", materialName: "Beige" },
      { grnId: "grn-1", materialCode: "FAB-002", materialName: "Beige" },
      { grnId: "grn-1", materialCode: "FAB-001", materialName: "Navy" },
      { grnId: "grn-1", materialCode: "FAB-002", materialName: "Cream" },
    ],
  });

  const res = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(res.rmCreated, 1);
  assert.equal(db.state.inspections.length, 1);
  assert.equal(db.state.inspections[0].templateId, "qct-rm-fabric");
});

test("a MIXED receipt raises one inspection per material family, all naming the same receipt", async () => {
  const db = makeDb({
    templates: RM_TEMPLATES,
    templateItems: RM_TEMPLATE_ITEMS,
    rawMaterials: RAW_MATERIALS,
    grns: [{ id: "grn-1", grnNumber: "GRN-0007", supplierId: "sup-a", supplierName: "Add Wood", receiveDate: SLOT_DATE, status: "POSTED" }],
    grnItems: [
      { grnId: "grn-1", materialCode: "WD-001", materialName: "Wood strip 2x2" },
      { grnId: "grn-1", materialCode: "PLY-001", materialName: "Plywood 9mm" },
      { grnId: "grn-1", materialCode: "FAB-001", materialName: "Sofa fabric grey" },
    ],
  });

  const res = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(res.rmCreated, 3, "timber, plywood and fabric are three different physical checks");
  assert.deepEqual(
    db.state.inspections.map((r) => r.templateId).sort(),
    ["qct-rm-fabric", "qct-rm-plywood", "qct-rm-wood"],
  );
  assert.ok(
    db.state.inspections.every((r) => r.sourceGrnId === "grn-1"),
    "all three must stay attached to the receipt they came from",
  );
});

test("re-running generation raises no second inspection for the same receipt", async () => {
  const fixture = {
    templates: RM_TEMPLATES,
    templateItems: RM_TEMPLATE_ITEMS,
    rawMaterials: RAW_MATERIALS,
    grns: [{ id: "grn-1", grnNumber: "GRN-0001", supplierId: "sup-b", supplierName: "Fabric Co", receiveDate: SLOT_DATE, status: "POSTED" }],
    grnItems: [{ grnId: "grn-1", materialCode: "FAB-001", materialName: "Grey" }],
  };
  const db = makeDb(fixture);

  assert.equal((await generatePendingForSlot(db.DB, SLOT)).rmCreated, 1);

  // Same slot again…
  const again = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(again.rmCreated, 0);
  // …and the OTHER slot the same day. The receipt is not tied to a slot, so
  // the 16:00 run must not raise a second inspection for the same goods.
  const laterSlot = await generatePendingForSlot(db.DB, SLOT_2);
  assert.equal(laterSlot.rmCreated, 0, "idempotency is keyed on the receipt, not the slot");
  assert.equal(db.state.inspections.length, 1);
});

test("an RM inspection carries the receipt as its subject", async () => {
  const db = makeDb({
    templates: RM_TEMPLATES,
    templateItems: RM_TEMPLATE_ITEMS,
    rawMaterials: RAW_MATERIALS,
    grns: [{ id: "grn-9", grnNumber: "GRN-0009", supplierId: "sup-a", supplierName: "Add Wood Sdn Bhd", receiveDate: SLOT_DATE, status: "POSTED" }],
    grnItems: [{ grnId: "grn-9", materialCode: "WD-001", materialName: "Wood strip" }],
  });
  await generatePendingForSlot(db.DB, SLOT);
  const row = db.state.inspections[0];
  assert.equal(row.subjectType, "RM_BATCH");
  assert.equal(row.subjectId, "grn-9");
  assert.match(row.subjectLabel, /GRN-0009/);
  assert.match(row.subjectLabel, /Add Wood Sdn Bhd/);
  assert.equal(row.materialFamily, "TIMBER");
});

test("a receipt of goods with no material master still gets inspected", async () => {
  // Fail OPEN. An unresolvable line means our master data is wrong, not that
  // the goods are fine — the general checklist asks the inspector to say what
  // arrived so the item group can be corrected.
  const db = makeDb({
    templates: RM_TEMPLATES,
    templateItems: RM_TEMPLATE_ITEMS,
    rawMaterials: RAW_MATERIALS,
    grns: [{ id: "grn-x", grnNumber: "GRN-0100", supplierId: null, supplierName: "New supplier", receiveDate: SLOT_DATE, status: "CONFIRMED" }],
    grnItems: [{ grnId: "grn-x", materialCode: "MYSTERY-1", materialName: "?" }],
  });
  const res = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(res.rmCreated, 1);
  assert.equal(db.state.inspections[0].templateId, "qct-rm-general");
});

test("a DRAFT receipt is not goods received, and an old receipt is out of the lookback", async () => {
  const draft = makeDb({
    templates: RM_TEMPLATES,
    templateItems: RM_TEMPLATE_ITEMS,
    rawMaterials: RAW_MATERIALS,
    grns: [{ id: "g", grnNumber: "GRN-1", supplierId: "s", supplierName: "S", receiveDate: SLOT_DATE, status: "DRAFT" }],
    grnItems: [{ grnId: "g", materialCode: "FAB-001" }],
  });
  assert.equal((await generatePendingForSlot(draft.DB, SLOT)).rmCreated, 0);

  const ancient = makeDb({
    templates: RM_TEMPLATES,
    templateItems: RM_TEMPLATE_ITEMS,
    rawMaterials: RAW_MATERIALS,
    // Two months back. The lookback is 7 days on purpose: an unbounded scan
    // would raise thousands of inspections for consumed goods on the first run
    // after deploy, which is the wallpaper backlog all over again.
    grns: [{ id: "g", grnNumber: "GRN-1", supplierId: "s", supplierName: "S", receiveDate: "2026-06-01", status: "POSTED" }],
    grnItems: [{ grnId: "g", materialCode: "FAB-001" }],
  });
  assert.equal((await generatePendingForSlot(ancient.DB, SLOT)).rmCreated, 0);

  const recent = makeDb({
    templates: RM_TEMPLATES,
    templateItems: RM_TEMPLATE_ITEMS,
    rawMaterials: RAW_MATERIALS,
    // Confirmed on the Friday, generation running on the Monday — still caught.
    grns: [{ id: "g", grnNumber: "GRN-1", supplierId: "s", supplierName: "S", receiveDate: "2026-08-04T16:20:00.000Z", status: "POSTED" }],
    grnItems: [{ grnId: "g", materialCode: "FAB-001" }],
  });
  assert.equal((await generatePendingForSlot(recent.DB, SLOT)).rmCreated, 1);
});

// ── WIP: unchanged — twice daily, gated on the department working ───────────

test("a department with no production generates no WIP slot", async () => {
  const db = makeDb({
    templates: [
      tpl({ id: "t-sew", deptCode: "FAB_SEW" }),
      tpl({ id: "t-foam", deptCode: "FOAM" }),
    ],
    templateItems: [tplItem("t-sew", 1), tplItem("t-foam", 1)],
    // FAB_SEW is working. FOAM has nothing at all.
    jobCards: [{ departmentCode: "FAB_SEW", status: "IN_PROGRESS", completedDate: null }],
  });

  const res = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(res.created, 1);
  assert.equal(res.skippedNoActivity, 1);
  assert.deepEqual(db.state.inspections.map((r) => r.department), ["FAB_SEW"],
    "FOAM made nothing today — it must not be handed an inspection to answer");
});

test("a department whose only cards are WAITING is a queue, not production", async () => {
  const db = makeDb({
    templates: [tpl({ id: "t-sew", deptCode: "FAB_SEW" })],
    templateItems: [tplItem("t-sew", 1)],
    jobCards: [{ departmentCode: "FAB_SEW", status: "WAITING", completedDate: null }],
  });
  const res = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(res.created, 0);
  assert.equal(res.skippedNoActivity, 1);
});

test("a department that finished work today still gets its slot", async () => {
  const db = makeDb({
    templates: [tpl({ id: "t-sew", deptCode: "FAB_SEW" })],
    templateItems: [tplItem("t-sew", 1)],
    jobCards: [{ departmentCode: "FAB_SEW", status: "COMPLETED", completedDate: SLOT_DATE }],
  });
  assert.equal((await generatePendingForSlot(db.DB, SLOT)).created, 1);
});

test("WIP is still twice daily — the 16:00 slot is a second follow-up, not a duplicate", async () => {
  // 早上一次、下午一次. Two slots the same day is the POINT for WIP, which is
  // exactly why RM could not share the same idempotency key.
  const db = makeDb({
    templates: [tpl({ id: "t-sew", deptCode: "FAB_SEW" })],
    templateItems: [tplItem("t-sew", 1)],
    jobCards: [{ departmentCode: "FAB_SEW", status: "IN_PROGRESS", completedDate: null }],
  });
  assert.equal((await generatePendingForSlot(db.DB, SLOT)).created, 1);
  assert.equal((await generatePendingForSlot(db.DB, SLOT_2)).created, 1);
  assert.equal(db.state.inspections.length, 2);
});

test("a probe that throws still generates — never silently stop doing QC", async () => {
  const db = makeDb({
    templates: [tpl({ id: "t-sew", deptCode: "FAB_SEW" })],
    templateItems: [tplItem("t-sew", 1)],
  });
  const realPrepare = db.DB.prepare.bind(db.DB);
  db.DB.prepare = (sql) => {
    if (/FROM job_cards/i.test(sql)) {
      return { bind: () => ({ first: async () => { throw new Error("table missing"); } }) };
    }
    return realPrepare(sql);
  };
  assert.equal((await generatePendingForSlot(db.DB, SLOT)).created, 1,
    "over-generating is a nuisance; silently generating nothing is how you " +
    "come to believe you have QC when you don't");
});

test("re-running the same slot is still idempotent", async () => {
  const db = makeDb({
    templates: [tpl({ id: "t-sew", deptCode: "FAB_SEW" })],
    templateItems: [tplItem("t-sew", 1)],
    jobCards: [{ departmentCode: "FAB_SEW", status: "IN_PROGRESS", completedDate: null }],
  });
  assert.equal((await generatePendingForSlot(db.DB, SLOT)).created, 1);
  const second = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 1);
  assert.equal(db.state.inspections.length, 1);
});

// ── FG: a sampled share of production, bound to a unit and its order ────────

const FG_TEMPLATES = [
  tpl({ id: "qct-fg-sofa", stage: "FG", deptCode: "PACKING", itemCategory: "SOFA" }),
  tpl({ id: "qct-fg-bf", stage: "FG", deptCode: "PACKING", itemCategory: "BEDFRAME" }),
];
const FG_TEMPLATE_ITEMS = FG_TEMPLATES.map((t) => tplItem(t.id, 1));

function fgUnit(n, over = {}) {
  return {
    id: `fgu-${String(n).padStart(3, "0")}`,
    unitSerial: `SN-${n}`,
    soId: `so-${n}`,
    soNo: `SO-${1000 + n}`,
    soLineNo: 1,
    productCode: `P-${n}`,
    productName: "Sofa 3 seater",
    unitNo: 1,
    totalUnits: 1,
    customerName: "Cust",
    customerHub: "JB",
    mfdDate: SLOT_DATE,
    packedAt: null,
    itemCategory: "SOFA",
    soProductCode: `P-${n}`,
    sizeCode: "3S",
    sizeLabel: "3 Seater",
    fabricCode: "FAB-001",
    quantity: 1,
    specialOrder: null,
    legHeightInches: 4,
    divanHeightInches: null,
    soLineNotes: null,
    ...over,
  };
}

test("FG sampling is a share of what was produced, not one blind slot", async () => {
  const mk = (count) => makeDb({
    templates: FG_TEMPLATES,
    templateItems: FG_TEMPLATE_ITEMS,
    fgUnits: Array.from({ length: count }, (_, i) => fgUnit(i + 1)),
  });

  assert.equal((await generatePendingForSlot(mk(0).DB, SLOT)).fgCreated, 0,
    "nothing was produced — there is nothing to sample");
  assert.equal((await generatePendingForSlot(mk(1).DB, SLOT)).fgCreated, 1,
    "anything produced gets looked at at least once");
  assert.equal((await generatePendingForSlot(mk(12).DB, SLOT)).fgCreated, 2,
    "10% of 12, rounded up");
  assert.equal((await generatePendingForSlot(mk(200).DB, SLOT)).fgCreated, 5,
    "capped per slot — 20 tick-box exercises is not 20 inspections");
});

test("fgSampleTarget is the sampling rule, stated once", () => {
  assert.equal(fgSampleTarget(0), 0);
  assert.equal(fgSampleTarget(1), 1);
  assert.equal(fgSampleTarget(10), 1);
  assert.equal(fgSampleTarget(11), 2);
  assert.equal(fgSampleTarget(41), 5);
  assert.equal(fgSampleTarget(1000), 5);
});

test("each FG slot names ONE unit and carries its sales-order line", async () => {
  const db = makeDb({
    templates: FG_TEMPLATES,
    templateItems: FG_TEMPLATE_ITEMS,
    fgUnits: [fgUnit(1, { fabricCode: "FAB-777", sizeLabel: "2 Seater", soNo: "SO-9001" })],
  });
  await generatePendingForSlot(db.DB, SLOT);
  const row = db.state.inspections[0];
  assert.equal(row.subjectType, "FG_BATCH");
  assert.equal(row.sourceFgUnitId, "fgu-001");
  assert.match(row.subjectLabel, /SO-9001/);
  const spec = JSON.parse(row.soSpec);
  assert.equal(spec.soNo, "SO-9001");
  assert.equal(spec.fabricCode, "FAB-777");
  assert.equal(spec.sizeLabel, "2 Seater");
});

test("the second slot of the day samples DIFFERENT units, and a re-run samples none", async () => {
  const db = makeDb({
    templates: FG_TEMPLATES,
    templateItems: FG_TEMPLATE_ITEMS,
    fgUnits: Array.from({ length: 12 }, (_, i) => fgUnit(i + 1)),
  });

  assert.equal((await generatePendingForSlot(db.DB, SLOT)).fgCreated, 2);
  const firstPick = db.state.inspections.map((r) => r.sourceFgUnitId);

  // Re-running the SAME slot must add nothing.
  assert.equal((await generatePendingForSlot(db.DB, SLOT)).fgCreated, 0);
  assert.equal(db.state.inspections.length, 2);

  // The 16:00 slot samples again — and must not hand back units already done.
  assert.equal((await generatePendingForSlot(db.DB, SLOT_2)).fgCreated, 2);
  const secondPick = db.state.inspections.slice(2).map((r) => r.sourceFgUnitId);
  assert.equal(secondPick.filter((u) => firstPick.includes(u)).length, 0,
    "re-inspecting the same piece twice in a day samples nothing new");
});

test("sofa and bedframe are sampled against their own template", async () => {
  const db = makeDb({
    templates: FG_TEMPLATES,
    templateItems: FG_TEMPLATE_ITEMS,
    fgUnits: [
      fgUnit(1, { itemCategory: "SOFA" }),
      fgUnit(2, { itemCategory: "BEDFRAME" }),
    ],
  });
  await generatePendingForSlot(db.DB, SLOT);
  assert.deepEqual(
    db.state.inspections.map((r) => r.templateId).sort(),
    ["qct-fg-bf", "qct-fg-sofa"],
  );
});

test("a finished unit with no sales-order line is reported, not silently dropped", async () => {
  const db = makeDb({
    templates: FG_TEMPLATES,
    templateItems: FG_TEMPLATE_ITEMS,
    fgUnits: [fgUnit(1), fgUnit(2, { itemCategory: null })],
  });
  const res = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(res.fgUnresolved, 1,
    "a finished unit with no traceable order is itself the finding");
  assert.equal(res.fgUnits, 2);
});

// ── Inspection numbers ──────────────────────────────────────────────────────

test("two inspections in one slot get different numbers", async () => {
  const templates = ["a", "b", "c", "d", "e"].map((k) =>
    tpl({ id: `t-${k}`, deptCode: `DEPT_${k.toUpperCase()}` }),
  );
  const db = makeDb({
    templates,
    templateItems: templates.map((t) => tplItem(t.id, 1)),
    jobCards: templates.map((t) => ({
      departmentCode: t.deptCode, status: "IN_PROGRESS", completedDate: null,
    })),
  });

  const res = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(res.created, 5);
  const numbers = db.state.inspections.map((r) => r.inspectionNo);
  assert.equal(new Set(numbers).size, 5, `all five collided onto: ${numbers.join(", ")}`);
});

test("numbers stay unique across WIP, RM and FG in the same run", async () => {
  const db = makeDb({
    templates: [tpl({ id: "t-sew", deptCode: "FAB_SEW" }), ...RM_TEMPLATES, ...FG_TEMPLATES],
    templateItems: [tplItem("t-sew", 1), ...RM_TEMPLATE_ITEMS, ...FG_TEMPLATE_ITEMS],
    jobCards: [{ departmentCode: "FAB_SEW", status: "IN_PROGRESS", completedDate: null }],
    rawMaterials: RAW_MATERIALS,
    grns: [{ id: "grn-1", grnNumber: "GRN-1", supplierId: "s", supplierName: "S", receiveDate: SLOT_DATE, status: "POSTED" }],
    grnItems: [{ grnId: "grn-1", materialCode: "FAB-001" }],
    fgUnits: [fgUnit(1)],
  });
  const res = await generatePendingForSlot(db.DB, SLOT);
  assert.equal(res.created, 3, "one WIP + one RM + one FG");
  const numbers = db.state.inspections.map((r) => r.inspectionNo);
  assert.equal(new Set(numbers).size, 3,
    `one allocator serves all three stages: ${numbers.join(", ")}`);
});

test("numbers keep climbing across runs and survive a deleted slot", async () => {
  const mk = (over) => makeDb({
    templates: [tpl({ id: "t-sew", deptCode: "FAB_SEW" })],
    templateItems: [tplItem("t-sew", 1)],
    jobCards: [{ departmentCode: "FAB_SEW", status: "IN_PROGRESS", completedDate: null }],
    ...over,
  });

  const db = mk({});
  await generatePendingForSlot(db.DB, SLOT);
  const first = db.state.inspections[0].inspectionNo;

  // Second slot, same day, same store.
  await generatePendingForSlot(db.DB, SLOT_2);
  const second = db.state.inspections[1].inspectionNo;
  assert.notEqual(first, second);

  // Now DELETE the first one (the route allows cancelling a PENDING slot).
  // A COUNT(*)-based allocator would hand its number straight to the next
  // run; the max-suffix allocator does not.
  db.state.inspections.splice(0, 1);
  await generatePendingForSlot(db.DB, "2026-08-08T04:00:00.000Z");
  const third = db.state.inspections[db.state.inspections.length - 1].inspectionNo;
  assert.notEqual(third, second);
  assert.notEqual(third, first);
});
