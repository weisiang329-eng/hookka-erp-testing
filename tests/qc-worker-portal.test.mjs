// ---------------------------------------------------------------------------
// QC on the phone.
//
// Before 2026-08-07 the shop floor could not reach QC AT ALL: "qc" appeared
// zero times in src/pages/worker/ and in src/api/routes/worker.ts, and QC
// existed only in the desktop ERP sidebar, which a machinist never opens.
// That is a large part of why 3,009 inspections sat PENDING for three months.
//
// /api/worker/* is auth-bypassed for cookies but NOT unauthenticated: the
// X-Worker-Token IS the credential. These tests assert the guards that make a
// phone-submitted inspection safe, because a WIP FAIL is not a note — it
// RESETS a job card to BLOCKED and clears its piece_pics:
//
//   • no token           -> 401
//   • another department -> 403
//   • a job card that is not live in the caller's department -> 403
//   • a FAIL with no words -> 400
//   • and the happy path really does complete the inspection.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import workerApp from "../src/api/routes/worker.ts";

const TODAY = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TOKEN = "wt-good-token";
// What the phone actually posts: a compressed JPEG data URL (see
// @/lib/image-compress), the same shape service_cases.issue_photos uses.
const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==";

function makeDb(over = {}) {
  const state = {
    worker: {
      id: "emp-9", empNo: "E009", name: "Ah Meng", departmentId: "d1",
      departmentCode: "FAB_SEW", departmentCodes: null, categories: null,
      position: "Operator", phone: null, status: "ACTIVE", basicSalarySen: 0,
      workingHoursPerDay: 8, workingDaysPerMonth: 26, otMultiplier: 1.5,
    },
    jobCards: [
      { id: "jc-1", departmentCode: "FAB_SEW", status: "IN_PROGRESS", poNo: "PO-2608-001", wipLabel: "Seat cover", wipCode: "SEW", productionOrderId: "po-1" },
      { id: "jc-other", departmentCode: "FOAM", status: "IN_PROGRESS", poNo: "PO-2608-002", wipLabel: "Foam cut", wipCode: "FOAM", productionOrderId: "po-2" },
      { id: "jc-done", departmentCode: "FAB_SEW", status: "COMPLETED", poNo: "PO-2608-003", wipLabel: "Old", wipCode: "SEW", productionOrderId: "po-3" },
    ],
    inspections: [
      { id: "qc-mine", inspectionNo: "QC-2608-001", stage: "WIP", department: "FAB_SEW", itemCategory: "SOFA", status: "PENDING", scheduledSlotAt: `${TODAY}T04:00:00.000Z`, inspectionDate: TODAY, result: null, notes: null, inspectorId: null, inspectorName: null, subjectType: null, subjectId: null, subjectLabel: null, completedAt: null, templateId: "t1", templateSnapshot: null, triggerType: "SCHEDULED", skipReason: null, createdAt: `${TODAY}T04:00:00.000Z` },
      { id: "qc-theirs", inspectionNo: "QC-2608-002", stage: "WIP", department: "FOAM", itemCategory: "SOFA", status: "PENDING", scheduledSlotAt: `${TODAY}T04:00:00.000Z`, inspectionDate: TODAY, result: null, notes: null, inspectorId: null, inspectorName: null, subjectType: null, subjectId: null, subjectLabel: null, completedAt: null, templateId: "t2", templateSnapshot: null, triggerType: "SCHEDULED", skipReason: null, createdAt: `${TODAY}T04:00:00.000Z` },
    ],
    items: [
      { id: "it-1", inspectionId: "qc-mine", sequence: 1, itemName: "Seam straightness", criteria: "±2mm", severity: "MAJOR", isMandatory: 1, result: null, notes: null, photoUrl: null },
      { id: "it-2", inspectionId: "qc-mine", sequence: 2, itemName: "Thread tension", criteria: "", severity: "MINOR", isMandatory: 0, result: null, notes: null, photoUrl: null },
      { id: "it-3", inspectionId: "qc-theirs", sequence: 1, itemName: "Foam density", criteria: "", severity: "MAJOR", isMandatory: 1, result: null, notes: null, photoUrl: null },
    ],
    tags: [],
    defects: [],
    tokenValid: true,
    ...over,
  };

  const norm = (s) => s.replace(/\s+/g, " ").trim();

  function exec(rawSql, args) {
    const s = norm(rawSql);

    // worker-auth token resolution
    if (/FROM worker_tokens|worker_sessions|FROM worker_auth/i.test(s)) {
      return { rows: state.tokenValid ? [{ workerId: state.worker.id, workerid: state.worker.id, expiresAt: null }] : [], changes: 0 };
    }
    if (/^SELECT id, empNo, name, departmentId/i.test(s)) {
      return { rows: args[0] === state.worker.id ? [{ ...state.worker }] : [], changes: 0 };
    }
    // current-dept derivation — no scan, no punch: falls back to home dept.
    if (/FROM dept_scan_events/i.test(s)) return { rows: [], changes: 0 };
    if (/FROM attendance_records/i.test(s)) return { rows: [], changes: 0 };

    if (/^SELECT jc\.id AS id, po\.poNo AS poNo/i.test(s)) {
      const [dept, ...statuses] = args;
      return {
        rows: state.jobCards
          .filter((j) => j.departmentCode === dept && statuses.includes(j.status))
          .map((j) => ({ id: j.id, poNo: j.poNo, wipLabel: j.wipLabel, wipCode: j.wipCode, status: j.status })),
        changes: 0,
      };
    }
    if (/^SELECT id, inspectionNo, stage, department, itemCategory, status/i.test(s)) {
      const [dept, date] = args;
      return {
        rows: state.inspections
          .filter((r) => r.department === dept && r.stage === "WIP" &&
            ["PENDING", "IN_PROGRESS"].includes(r.status) && r.inspectionDate === date)
          .map((r) => ({ ...r })),
        changes: 0,
      };
    }
    if (/^SELECT id, inspectionId, sequence, itemName/i.test(s)) {
      return { rows: state.items.filter((i) => args.includes(i.inspectionId)).map((i) => ({ ...i })), changes: 0 };
    }
    if (/^SELECT id, stage, department, status FROM qc_inspections WHERE id = \?$/i.test(s)) {
      const r = state.inspections.find((x) => x.id === args[0]);
      return { rows: r ? [{ id: r.id, stage: r.stage, department: r.department, status: r.status }] : [], changes: 0 };
    }
    if (/^SELECT \* FROM qc_inspections WHERE id = \?$/i.test(s)) {
      const r = state.inspections.find((x) => x.id === args[0]);
      return { rows: r ? [{ ...r }] : [], changes: 0 };
    }
    if (/^SELECT \* FROM qc_inspection_items WHERE inspectionId = \?/i.test(s)) {
      return { rows: state.items.filter((i) => i.inspectionId === args[0]).map((i) => ({ ...i })), changes: 0 };
    }
    if (/^UPDATE qc_inspection_items SET result = \?/i.test(s)) {
      const row = state.items.find((i) => i.id === args[3]);
      if (row) { row.result = args[0]; row.notes = args[1]; row.photoUrl = args[2]; }
      return { rows: [], changes: row ? 1 : 0 };
    }
    if (/^UPDATE qc_inspections SET status = 'COMPLETED'/i.test(s)) {
      // The trailing `inspectionDate = COALESCE(inspectionDate, ?)` binds a
      // server-computed date BEFORE the id — see completeInspection.
      const [result, subjectType, subjectId, subjectLabel, notes, inspectorId, inspectorName, completedAt, dateFallback, id] = args;
      const row = state.inspections.find((r) => r.id === id);
      if (row) Object.assign(row, { status: "COMPLETED", result, subjectType, subjectId, subjectLabel, notes, inspectorId, inspectorName, completedAt, inspectionDate: row.inspectionDate ?? dateFallback });
      return { rows: [], changes: row ? 1 : 0 };
    }
    if (/^INSERT INTO qc_tags/i.test(s)) { state.tags.push(args); return { rows: [], changes: 1 }; }
    if (/^INSERT INTO qc_defects/i.test(s)) { state.defects.push(args); return { rows: [], changes: 1 }; }
    if (/^UPDATE job_cards SET status = 'BLOCKED'/i.test(s)) {
      const row = state.jobCards.find((j) => j.id === args[0]);
      if (row) row.status = "BLOCKED";
      return { rows: [], changes: row ? 1 : 0 };
    }
    if (/^UPDATE piece_pics SET/i.test(s)) { state.piecePicsCleared = args[0]; return { rows: [], changes: 1 }; }
    if (/^SELECT productionOrderId FROM job_cards WHERE id = \?$/i.test(s)) {
      const row = state.jobCards.find((j) => j.id === args[0]);
      return { rows: row ? [{ productionOrderId: row.productionOrderId }] : [], changes: 0 };
    }
    // recomputePoStatusAndProgress — out of scope for these assertions; it is
    // wrapped in try/catch by the caller, so throwing here is realistic AND
    // proves the submission still commits.
    throw new Error(`unexpected SQL: ${s}`);
  }

  const DB = {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...a) { bound = a; stmt._bound = a; return stmt; },
        async run() { const r = exec(sql, bound); return { success: true, meta: { changes: r.changes } }; },
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

function mount(db) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db.DB);
    c.set("orgId", "hookka");
    await next();
  });
  parent.route("/", workerApp);
  return parent;
}

function call(db, method, path, { token = TOKEN, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-worker-token"] = token;
  return mount(db).request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ── The read ────────────────────────────────────────────────────────────────

test("the phone sees only its own department's slots for today", async () => {
  const db = makeDb();
  const res = await call(db, "GET", "/qc-today");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.data.deptCode, "FAB_SEW");
  assert.deepEqual(j.data.inspections.map((i) => i.id), ["qc-mine"],
    "FOAM's slot must never appear on a FAB_SEW worker's phone");
  assert.equal(j.data.inspections[0].items.length, 2);
  // The subject list is this department's LIVE cards only.
  assert.deepEqual(j.data.subjects.map((s) => s.id), ["jc-1"]);
});

test("no worker token is 401, not an open door", async () => {
  const db = makeDb();
  const res = await call(db, "GET", "/qc-today", { token: null });
  assert.equal(res.status, 401);
});

// ── The write ───────────────────────────────────────────────────────────────

test("a worker completes their own department's WIP slot from the phone", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-mine/complete", {
    body: { subjectId: "jc-1", items: [{ id: "it-1", result: "PASS" }, { id: "it-2", result: "NA" }] },
  });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(j.success, true);
  assert.equal(j.data.status, "COMPLETED");
  assert.equal(j.data.result, "PASS");
  const row = db.state.inspections.find((r) => r.id === "qc-mine");
  assert.equal(row.status, "COMPLETED");
  // Attributed to the worker who actually stood there, by name — resolved from
  // the X-Worker-Token, never from the posted body.
  assert.equal(row.inspectorId, "emp-9");
  assert.equal(row.inspectorName, "Ah Meng");
  // …and stamped with the SERVER's clock. A phone with a wrong date, or one
  // that simply posts a time, must not decide when the factory inspected
  // something. The body above carries no time at all and there is nowhere to
  // put one.
  const completed = Date.parse(row.completedAt);
  assert.ok(Number.isFinite(completed) && Math.abs(Date.now() - completed) < 60_000,
    "completedAt must be the server clock at submission time");
  assert.equal(row.inspectionDate, TODAY);
});

test("a FAIL resets the job card and clears its piece stamps — via the SAME core as the desktop", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-mine/complete", {
    body: {
      subjectId: "jc-1",
      items: [
        { id: "it-1", result: "FAIL", notes: "Seam wandering 6mm at the left arm", photoUrl: PHOTO },
        { id: "it-2", result: "PASS" },
      ],
    },
  });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(j.data.result, "FAIL");
  assert.equal(j.sideEffects.jobCardReset, true);
  assert.equal(j.sideEffects.tagsCreated, 1);
  assert.equal(db.state.jobCards.find((x) => x.id === "jc-1").status, "BLOCKED");
  // BUG-2026-06-08: without the piece_pics clear a later scan re-derives "all
  // pieces done" and silently un-blocks the card. The phone must not be a
  // second, weaker copy of this.
  assert.equal(db.state.piecePicsCleared, "jc-1");
});

test("a FAIL with no words is refused", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-mine/complete", {
    body: { subjectId: "jc-1", items: [{ id: "it-1", result: "FAIL" }, { id: "it-2", result: "PASS" }] },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /say what failed/i);
  assert.equal(db.state.inspections.find((r) => r.id === "qc-mine").status, "PENDING");
});

// ── The photo (owner 2026-08-08: "全部东西都要有照片、有记录") ────────────────
//
// `photoUrl` was plumbed end to end and had NO uploader on either surface, so
// it was always null. Now the phone captures it — and the phone is the surface
// that matters, because the inspector is standing at the bench with the defect
// in front of them. These assert the RULE, not the widget: a FAIL without a
// picture does not become a record, and the picture the phone sends actually
// lands on the row.

test("a FAIL with no photo is refused by the backend, not just by the screen", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-mine/complete", {
    body: {
      subjectId: "jc-1",
      items: [
        { id: "it-1", result: "FAIL", notes: "Seam wandering 6mm at the left arm" },
        { id: "it-2", result: "PASS" },
      ],
    },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /attach a photo/i);
  // Nothing committed — not the inspection, and above all not the job-card reset.
  assert.equal(db.state.inspections.find((r) => r.id === "qc-mine").status, "PENDING");
  assert.equal(db.state.jobCards.find((x) => x.id === "jc-1").status, "IN_PROGRESS");
});

test("the photo the phone sends is stored on the item row", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-mine/complete", {
    body: {
      subjectId: "jc-1",
      items: [
        { id: "it-1", result: "FAIL", notes: "Seam wandering 6mm at the left arm", photoUrl: PHOTO },
        { id: "it-2", result: "PASS" },
      ],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  // The worker route used to drop photoUrl on the floor while building the
  // items array — the field reached the API and never reached the column.
  assert.equal(db.state.items.find((i) => i.id === "it-1").photoUrl, PHOTO);
  assert.equal((await res.json()).data.items.find((i) => i.id === "it-1").photoUrl, PHOTO);
});

test("a PASS needs no photo, and may still carry one", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-mine/complete", {
    body: {
      subjectId: "jc-1",
      items: [
        { id: "it-1", result: "PASS" },
        { id: "it-2", result: "PASS", photoUrl: PHOTO },
      ],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(db.state.items.find((i) => i.id === "it-1").photoUrl, null);
  assert.equal(db.state.items.find((i) => i.id === "it-2").photoUrl, PHOTO);
});

test("an attachment that is not an image is refused", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-mine/complete", {
    body: {
      subjectId: "jc-1",
      items: [
        { id: "it-1", result: "FAIL", notes: "Seam wandering", photoUrl: "data:text/html;base64,PHNjcmlwdD4=" },
        { id: "it-2", result: "PASS" },
      ],
    },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not an image/i);
});

test("a phone cannot answer for another department", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-theirs/complete", {
    body: { subjectId: "jc-other", items: [{ id: "it-3", result: "PASS" }] },
  });
  assert.equal(res.status, 403);
  assert.equal(db.state.inspections.find((r) => r.id === "qc-theirs").status, "PENDING");
});

test("a phone cannot point a FAIL at a job card outside its department", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-mine/complete", {
    body: { subjectId: "jc-other", items: [{ id: "it-1", result: "FAIL", notes: "x" }, { id: "it-2", result: "PASS" }] },
  });
  assert.equal(res.status, 403);
  // The other department's card is untouched — this is the whole point of the
  // second check: a FAIL is a write against whatever id you name.
  assert.equal(db.state.jobCards.find((x) => x.id === "jc-other").status, "IN_PROGRESS");
});

test("a finished card is not offered as a subject and is refused if named", async () => {
  const db = makeDb();
  const res = await call(db, "POST", "/qc/qc-mine/complete", {
    body: { subjectId: "jc-done", items: [{ id: "it-1", result: "PASS" }, { id: "it-2", result: "PASS" }] },
  });
  assert.equal(res.status, 403);
});
