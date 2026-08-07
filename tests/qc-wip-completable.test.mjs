// ---------------------------------------------------------------------------
// A WIP (IPQC) inspection must be completable end to end.
//
// Measured on prod 2026-08-07: 3,009 qc_inspections rows existed and ALL 3,009
// were still PENDING — not one had ever been completed since the first slot on
// 2026-04-28. 1,947 of them (65%) were WIP, and WIP was not merely unused, it
// was IMPOSSIBLE:
//
//   • src/pages/quality.tsx asked GET /api/job-cards?status=IN_PROGRESS&
//     departmentCode=<dept> for the subject dropdown,
//   • src/api/routes/job-cards.ts returned 400 unless picId was supplied
//     (quality.tsx never sent one),
//   • and even with a picId the WHERE hard-coded
//     `status IN ('COMPLETED','TRANSFERRED') AND completedDate IS NOT NULL`,
//     so an IN_PROGRESS card could never match, while `departmentCode` was
//     not read by the handler at all.
//
// So the dropdown was permanently empty, the Submit button stayed disabled,
// and the page rendered the empty list as the reassuring line "No active job
// cards in this department. Use Skip if no production today." A bug wearing
// the costume of a normal business state.
//
// These tests drive the REAL Hono subapps against an in-memory database and
// assert what a QC inspector can actually DO, not what the source says.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import jobCardsApp from "../src/api/routes/job-cards.ts";
import qcPendingApp from "../src/api/routes/qc-pending.ts";

const ORG = "hookka";

// ---------------------------------------------------------------------------
// A tiny stand-in for the DB. It answers exactly the statements these two
// routes issue against job_cards / qc_inspections / qc_inspection_items —
// anything else throws, so a route that quietly starts reading a new table
// fails loudly here.
// ---------------------------------------------------------------------------
function makeDb({ jobCards = [], inspections = [], inspectionItems = [] } = {}) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  function selectJobCards(sql, args) {
    // Re-implement the handler's filters from the SQL text it built, so the
    // test proves the WHERE clause is real rather than assuming it.
    let i = 0;
    const next = () => args[i++];
    let rows = jobCards.slice();
    const orgId = next();
    rows = rows.filter((r) => r.orgId === orgId);
    if (/\(jc\.pic1Id = \? OR jc\.pic2Id = \?\)/.test(sql)) {
      const p1 = next();
      const p2 = next();
      rows = rows.filter((r) => r.pic1Id === p1 || r.pic2Id === p2);
    }
    if (/jc\.departmentCode = \?/.test(sql)) {
      const dept = next();
      rows = rows.filter((r) => r.departmentCode === dept);
    }
    const statusCount = (norm(sql).match(/jc\.status IN \(([?, ]+)\)/)?.[1] ?? "")
      .split(",").filter((x) => x.trim() === "?").length;
    const statuses = [];
    for (let k = 0; k < statusCount; k++) statuses.push(next());
    rows = rows.filter((r) => statuses.includes(r.status));
    if (/jc\.completedDate IS NOT NULL/.test(sql)) {
      rows = rows.filter((r) => r.completedDate != null);
    }
    if (/jc\.completedDate >= \?/.test(sql)) {
      const from = next();
      rows = rows.filter((r) => r.completedDate >= from);
    }
    if (/jc\.completedDate <= \?/.test(sql)) {
      const to = next();
      rows = rows.filter((r) => r.completedDate <= to);
    }
    return rows.map((r) => ({ ...r }));
  }

  function exec(rawSql, args) {
    const sql = norm(rawSql);

    if (/^SELECT .* FROM job_cards jc/i.test(sql)) {
      return { rows: selectJobCards(sql, args), changes: 0 };
    }
    if (/^SELECT \* FROM qc_inspections WHERE id = \?$/i.test(sql)) {
      const row = inspections.find((r) => r.id === args[0]);
      return { rows: row ? [{ ...row }] : [], changes: 0 };
    }
    if (/^SELECT \* FROM qc_inspection_items WHERE inspectionId = \?/i.test(sql)) {
      return {
        rows: inspectionItems
          .filter((r) => r.inspectionId === args[0])
          .sort((a, b) => a.sequence - b.sequence)
          .map((r) => ({ ...r })),
        changes: 0,
      };
    }
    if (/^UPDATE qc_inspection_items SET result = \?, notes = \?, photoUrl = \? WHERE id = \?$/i.test(sql)) {
      const row = inspectionItems.find((r) => r.id === args[3]);
      if (!row) return { rows: [], changes: 0 };
      row.result = args[0];
      row.notes = args[1];
      row.photoUrl = args[2];
      return { rows: [], changes: 1 };
    }
    if (/^UPDATE qc_inspections SET status = 'COMPLETED'/i.test(sql)) {
      const [result, subjectType, subjectId, subjectLabel, notes,
        inspectorId, inspectorName, completedAt, id] = args;
      const row = inspections.find((r) => r.id === id);
      if (!row) return { rows: [], changes: 0 };
      Object.assign(row, {
        status: "COMPLETED", result, subjectType, subjectId, subjectLabel,
        notes, inspectorId, inspectorName, completedAt,
      });
      return { rows: [], changes: 1 };
    }

    throw new Error(`unexpected SQL: ${sql}`);
  }

  const DB = {
    prepare(sql) {
      let bound = [];
      const stmt = {
        _sql: sql,
        bind(...a) { bound = a; stmt._bound = a; return stmt; },
        async run() { const r = exec(sql, bound); return { success: true, meta: { changes: r.changes } }; },
        async first() { return exec(sql, bound).rows[0] ?? null; },
        async all() { return { results: exec(sql, bound).rows }; },
        _run() { return exec(sql, stmt._bound ?? []); },
      };
      return stmt;
    },
    async batch(stmts) {
      return stmts.map((s) => { s._run(); return { success: true }; });
    },
  };

  return { DB, jobCards, inspections, inspectionItems };
}

// Mount the real subapp behind the same context a logged-in QA user gets.
function mount(db, app) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db.DB);
    c.set("orgId", ORG);
    c.set("userRole", "SUPER_ADMIN");
    await next();
  });
  parent.route("/", app);
  return parent;
}

function liveCard(over = {}) {
  return {
    id: "jc-live-1",
    orgId: ORG,
    productionOrderId: "po-1",
    poNo: "PO-2608-001",
    productCode: "SOFA-A",
    departmentCode: "FAB_SEW",
    departmentName: "Fabric Sewing",
    sequence: 2,
    wipCode: "SEW",
    wipLabel: "Seat cover sewing",
    wipQty: 2,
    completedDate: null,
    productionTimeMinutes: 0,
    status: "IN_PROGRESS",
    pic1Id: "emp-7",
    pic2Id: null,
    ...over,
  };
}

// ── The dropdown the inspector picks a subject from ─────────────────────────

test("the exact URL quality.tsx sends returns the department's live cards", async () => {
  const db = makeDb({
    jobCards: [
      liveCard(),
      liveCard({ id: "jc-live-2", status: "WAITING", sequence: 3, pic1Id: null }),
      liveCard({ id: "jc-live-3", status: "PAUSED", sequence: 4 }),
      // Same department, but finished — not a thing you can still inspect.
      liveCard({ id: "jc-done", status: "COMPLETED", completedDate: "2026-08-06" }),
      // Live, but a DIFFERENT department's work.
      liveCard({ id: "jc-other-dept", departmentCode: "FOAM" }),
      // Live in this department but belonging to another tenant.
      liveCard({ id: "jc-other-org", orgId: "someone-else" }),
    ],
  });

  const res = await mount(db, jobCardsApp).request(
    "/?status=IN_PROGRESS,WAITING,PAUSED&departmentCode=FAB_SEW",
  );
  assert.equal(res.status, 200, "no picId is supplied — this must not 400");
  const j = await res.json();
  assert.equal(j.success, true);
  assert.deepEqual(
    j.data.map((r) => r.id).sort(),
    ["jc-live-1", "jc-live-2", "jc-live-3"],
    "only this department's live cards, in this org",
  );
  // The dropdown label is built from these three.
  assert.equal(j.data[0].poNo, "PO-2608-001");
  assert.equal(j.data[0].departmentName, "Fabric Sewing");
});

test("an empty department is empty because it is idle, not because of a 400", async () => {
  const db = makeDb({ jobCards: [liveCard({ departmentCode: "FOAM" })] });
  const res = await mount(db, jobCardsApp).request(
    "/?status=IN_PROGRESS,WAITING,PAUSED&departmentCode=FAB_SEW",
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, []);
});

test("neither picId nor departmentCode is still refused — this is not a table scan", async () => {
  const db = makeDb({ jobCards: [liveCard()] });
  const res = await mount(db, jobCardsApp).request("/?status=IN_PROGRESS");
  assert.equal(res.status, 400);
});

test("the Employee Performance read is unchanged: picId still means finished cards only", async () => {
  const db = makeDb({
    jobCards: [
      liveCard({ id: "jc-open", status: "IN_PROGRESS", pic1Id: "emp-7" }),
      liveCard({ id: "jc-fin", status: "COMPLETED", completedDate: "2026-08-06", pic1Id: "emp-7" }),
      liveCard({ id: "jc-fin-no-date", status: "COMPLETED", completedDate: null, pic1Id: "emp-7" }),
    ],
  });
  const res = await mount(db, jobCardsApp).request("/?picId=emp-7");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.data.map((r) => r.id), ["jc-fin"]);
  assert.equal(j.data[0].picSlot, "PIC1");
});

// ── The submission itself ───────────────────────────────────────────────────

test("a WIP inspection can be completed end to end", async () => {
  const db = makeDb({
    jobCards: [liveCard()],
    inspections: [{
      id: "qc-abc123", inspectionNo: "QC-2608-001", templateId: "tpl-sew",
      templateSnapshot: null, stage: "WIP", itemCategory: "SOFA",
      department: "FAB_SEW", subjectType: null, subjectId: null,
      subjectLabel: null, triggerType: "SCHEDULED",
      scheduledSlotAt: "2026-08-07T04:00:00.000Z", status: "PENDING",
      result: null, notes: null, inspectorId: null, inspectorName: null,
      inspectionDate: "2026-08-07", skipReason: null, completedAt: null,
      createdAt: "2026-08-07T04:00:00.000Z",
    }],
    inspectionItems: [
      { id: "qcii-1", inspectionId: "qc-abc123", sequence: 1, itemName: "Seam straightness", criteria: "±2mm", severity: "MAJOR", isMandatory: 1, result: null, notes: null, photoUrl: null },
      { id: "qcii-2", inspectionId: "qc-abc123", sequence: 2, itemName: "Thread tension", criteria: "no puckering", severity: "MINOR", isMandatory: 1, result: null, notes: null, photoUrl: null },
    ],
  });
  const api = mount(db, qcPendingApp);

  // Step 1 — the inspector opens the department's live cards and picks one.
  const cards = await mount(db, jobCardsApp).request(
    "/?status=IN_PROGRESS,WAITING,PAUSED&departmentCode=FAB_SEW",
  );
  const picked = (await cards.json()).data[0];
  assert.ok(picked, "there has to be something to sample or nothing else can happen");

  // Step 2 — they submit the checklist against that card.
  const res = await api.request("/qc-abc123/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subjectType: "JOB_CARD",
      subjectId: picked.id,
      subjectLabel: `${picked.poNo} · ${picked.departmentName}`,
      subjectCode: picked.poNo,
      inspectorId: "usr-qa-1",
      inspectorName: "QA Lead",
      items: [
        { id: "qcii-1", result: "PASS" },
        { id: "qcii-2", result: "PASS" },
      ],
    }),
  });

  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.success, true);
  assert.equal(j.data.status, "COMPLETED");
  assert.equal(j.data.result, "PASS");
  assert.equal(j.data.subjectId, "jc-live-1");
  // And it is COMPLETED in the store, not just in the response envelope.
  assert.equal(db.inspections[0].status, "COMPLETED");
  assert.equal(db.inspections[0].completedAt != null, true);
  assert.deepEqual(db.inspectionItems.map((i) => i.result), ["PASS", "PASS"]);
});
