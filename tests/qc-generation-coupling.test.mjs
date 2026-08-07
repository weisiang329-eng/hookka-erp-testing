// ---------------------------------------------------------------------------
// QC slot generation must follow production, and inspection numbers must be
// unique.
//
// Measured on prod 2026-08-07: 3,009 inspections, every one PENDING, oldest
// slot 2026-04-28. Two causes lived in this file.
//
// 1. GENERATION WAS A BLIND SCHEDULE. `SELECT * FROM qc_templates WHERE
//    active = 1`, one row per template per slot, twice a day, forever —
//    regardless of whether that station produced anything or any goods were
//    received. 17 templates x 2 slots = 34 rows a day into a queue nobody
//    could ever clear, which is how a queue becomes wallpaper. Owner
//    2026-08-07: everything is SAMPLING, tied to actual volume.
//
// 2. inspectionNo COLLIDED. getNextInspectionNo() did a COUNT(*) inside the
//    per-template loop, but every INSERT was deferred to one db.batch() at
//    the end — so the count never moved and all 17 inspections in a slot were
//    stamped with the SAME number. An inspection number that identifies
//    seventeen inspections identifies none of them.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { generatePendingForSlot } from "../src/api/routes/qc-pending.ts";

const SLOT = "2026-08-07T04:00:00.000Z"; // 12:00 local (UTC+8)
const SLOT_DATE = "2026-08-07";

function makeDb({
  templates = [],
  templateItems = [],
  jobCards = [],
  grns = [],
  fgUnits = [],
  inspections = [],
} = {}) {
  const state = { inspections, inspectionItems: [] };
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  function exec(rawSql, args) {
    const s = norm(rawSql);

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

    // --- the activity probes ---
    if (/^SELECT 1 AS hit FROM job_cards/i.test(s)) {
      const [dept, date] = args;
      const hit = jobCards.some(
        (j) =>
          j.departmentCode === dept &&
          (["IN_PROGRESS", "PAUSED"].includes(j.status) || j.completedDate === date),
      );
      return { rows: hit ? [{ hit: 1 }] : [] };
    }
    if (/^SELECT 1 AS hit FROM grns/i.test(s)) {
      const pfx = args[0].replace(/%$/, "");
      const hit = grns.some(
        (g) => (g.receiveDate ?? "").startsWith(pfx) && ["CONFIRMED", "POSTED"].includes(g.status),
      );
      return { rows: hit ? [{ hit: 1 }] : [] };
    }
    if (/^SELECT 1 AS hit FROM fg_units/i.test(s)) {
      const pfx = args[0].replace(/%$/, "");
      const hit = fgUnits.some(
        (u) => (u.mfdDate ?? "").startsWith(pfx) || (u.packedAt ?? "").startsWith(pfx),
      );
      return { rows: hit ? [{ hit: 1 }] : [] };
    }

    if (/^INSERT INTO qc_inspections/i.test(s)) {
      const [id, inspectionNo, templateId, templateSnapshot, stage, itemCategory,
        department, scheduledSlotAt, inspectionDate, createdAt] = args;
      state.inspections.push({
        id, inspectionNo, templateId, templateSnapshot, stage, itemCategory,
        department, scheduledSlotAt, inspectionDate, createdAt,
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
    itemCategory: "SOFA", stage: "WIP", active: 1, notes: null, ...over,
  };
}
function tplItem(templateId, seq) {
  return {
    id: `ti-${templateId}-${seq}`, templateId, sequence: seq,
    itemName: `Check ${seq}`, criteria: null, severity: "MAJOR", isMandatory: 1,
  };
}

// ── Coupling to production ──────────────────────────────────────────────────

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

test("an RM slot follows goods actually received", async () => {
  const noGoods = makeDb({
    templates: [tpl({ id: "t-rm", stage: "RM", deptCode: "STORE" })],
    templateItems: [tplItem("t-rm", 1)],
    grns: [{ receiveDate: "2026-08-05", status: "POSTED" }],
  });
  assert.equal((await generatePendingForSlot(noGoods.DB, SLOT)).created, 0,
    "nothing arrived today — there is no incoming batch to sample");

  const draftOnly = makeDb({
    templates: [tpl({ id: "t-rm", stage: "RM", deptCode: "STORE" })],
    templateItems: [tplItem("t-rm", 1)],
    grns: [{ receiveDate: SLOT_DATE, status: "DRAFT" }],
  });
  assert.equal((await generatePendingForSlot(draftOnly.DB, SLOT)).created, 0,
    "a DRAFT GRN is not goods received");

  const received = makeDb({
    templates: [tpl({ id: "t-rm", stage: "RM", deptCode: "STORE" })],
    templateItems: [tplItem("t-rm", 1)],
    grns: [{ receiveDate: `${SLOT_DATE}T09:12:00.000Z`, status: "CONFIRMED" }],
  });
  assert.equal((await generatePendingForSlot(received.DB, SLOT)).created, 1,
    "goods arrived — sample them (timestamped receiveDate must still match the day)");
});

test("an FG slot follows units actually produced", async () => {
  const idle = makeDb({
    templates: [tpl({ id: "t-fg", stage: "FG", deptCode: "PACKING" })],
    templateItems: [tplItem("t-fg", 1)],
    fgUnits: [{ mfdDate: "2026-08-01", packedAt: null }],
  });
  assert.equal((await generatePendingForSlot(idle.DB, SLOT)).created, 0);

  const producing = makeDb({
    templates: [tpl({ id: "t-fg", stage: "FG", deptCode: "PACKING" })],
    templateItems: [tplItem("t-fg", 1)],
    fgUnits: [{ mfdDate: null, packedAt: `${SLOT_DATE}T14:40:00.000Z` }],
  });
  assert.equal((await generatePendingForSlot(producing.DB, SLOT)).created, 1);
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
  await generatePendingForSlot(db.DB, "2026-08-07T08:00:00.000Z");
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
