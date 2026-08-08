// ---------------------------------------------------------------------------
// wip-quantity-drift.test.mjs — the two mechanisms that made `wip_items`
// quantities wrong, and the read-only audit that proves they are fixed.
//
// Owner, 2026-08-08: "成本基本上我们都算不对的，这些成本没关系，不需要去看，
// 先看数量，查到完，解压正确." Quantity only — nothing here touches cost.
//
// A — the last stage never cleared its upstream. `applyWipInventoryChange`
//     decremented the previous stage only when a DOWNSTREAM card was scanned,
//     and the WIP→FG subtract took only the UPHOLSTERY cards' OWN rows. A stage
//     the floor skipped kept its +wipQty forever, on goods that shipped.
//
// B — a reverted-and-redone card was swallowed. The idempotency ticket was
//     keyed (org, jc, from, to), so complete → revert → complete collided with
//     its own first ticket: the second completion returned before applying
//     anything, while the revert's refund had already run. Upstream too HIGH,
//     the stage's own row too LOW — which is where the negative rows come from.
//
// These are BEHAVIOUR tests: they run the real cascade against an in-memory
// stub of the three tables it writes and assert the resulting balances, so a
// refactor that keeps the source shape but changes the arithmetic still fails.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Node 22.6+ strips types natively.
}

const {
  applyWipInventoryChange,
} = await import("../src/api/routes/production-orders/_helpers.ts");
const { reconcileWip } = await import("../src/api/lib/wip-expected.ts");

const ORG = "hookka";
const DONE = new Set(["COMPLETED", "TRANSFERRED"]);

// ---- In-memory DB stub -----------------------------------------------------
// Backs wip_items (code → qty) and wip_cascade_log (append-only ticket list),
// plus the two read-only lookups the FAB_SEW merge path makes. DDL from the
// self-apply is accepted as a no-op. Not a SQL engine — a dispatch table over
// the exact statements `applyWipInventoryChange` issues.
function makeDb(jobCards = []) {
  const wip = new Map(); // code -> qty
  const log = []; // { orgId, jcId, from, to, attempt, seq }
  let seq = 0;

  const setQty = (code, qty) => wip.set(code, qty);
  const bump = (code, delta) => wip.set(code, (wip.get(code) ?? 0) + delta);

  function prepare(sqlRaw) {
    const s = sqlRaw.replace(/\s+/g, " ").trim();
    let b = [];
    const obj = {
      bind(...args) {
        b = args;
        return obj;
      },
      async first() {
        if (/SELECT baseModel FROM bom_templates/i.test(s)) return null;
        // The FC lookups project only the columns the statement asks for, so
        // a cascade that stops SELECTing wipQty really does lose the number
        // and falls back to 1 — which is the C bug, and makes those tests
        // fail rather than quietly still passing.
        const project = (hit) => {
          if (!hit) return null;
          const row = { wipLabel: hit.wipLabel };
          if (/\bwipQty\b/i.test(s)) row.wipQty = hit.wipQty ?? null;
          return row;
        };
        if (/SELECT wipLabel(?:, wipQty)? FROM job_cards WHERE wipKey = \?/i.test(s)) {
          return project(
            jobCards.find(
              (j) => j.wipKey === b[0] && j.departmentCode === "FAB_CUT",
            ),
          );
        }
        if (
          /SELECT wipLabel(?:, wipQty)? FROM job_cards WHERE productionOrderId = \?/i.test(s)
        ) {
          return project(
            jobCards.find(
              (j) =>
                j.productionOrderId === b[0] && j.departmentCode === "FAB_CUT",
            ),
          );
        }
        if (/SELECT COUNT\(\*\) AS n FROM job_cards/i.test(s)) {
          const n = jobCards.filter(
            (j) =>
              j.id !== b[0] &&
              j.productionOrderId === b[1] &&
              j.departmentCode === "FAB_SEW" &&
              DONE.has(j.status),
          ).length;
          return { n };
        }
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        // --- self-apply DDL: accept, do nothing ---
        if (/^(CREATE|ALTER|DROP)\b/i.test(s)) return { meta: { changes: 0 } };

        // --- FIX B claim ticket ---
        // The stub reads the STATEMENT to decide which key it is enforcing, so
        // reverting the source to the old (org, jc, from, to) ticket makes the
        // revert/redo test fail instead of quietly still passing.
        if (/^INSERT INTO wip_cascade_log/i.test(s)) {
          const occurrenceKeyed = /\battempt\b/i.test(s);
          const [orgId, jcId, from, to] = b;
          const mine = log.filter((r) => r.orgId === orgId && r.jcId === jcId);
          const sameTransition = (r) =>
            (r.from ?? null) === (from ?? null) && r.to === to;
          if (!occurrenceKeyed) {
            // Legacy key: UNIQUE (org, jc, from, to) — one ticket per
            // transition, forever. This is the bug.
            if (mine.some(sameTransition)) return { meta: { changes: 0 } };
            log.push({ orgId, jcId, from, to, attempt: 0, seq: ++seq });
            return { meta: { changes: 1 } };
          }
          const latest = mine.length ? mine[mine.length - 1] : null;
          // Replay test: is this exact transition the LAST thing we applied?
          if (latest && sameTransition(latest)) return { meta: { changes: 0 } };
          const attempt = mine.filter(sameTransition).length;
          // UNIQUE (org, jc, from, to, attempt)
          if (mine.some((r) => sameTransition(r) && r.attempt === attempt)) {
            return { meta: { changes: 0 } };
          }
          log.push({ orgId, jcId, from, to, attempt, seq: ++seq });
          return { meta: { changes: 1 } };
        }

        // --- wip_items writes ---
        if (/^INSERT INTO wip_items/i.test(s)) {
          // (id, code, type, relatedProduct, deptStatus, stockQty)
          bump(b[1], Number(b[5]));
          return { meta: { changes: 1 } };
        }
        if (/UPDATE wip_items SET stockQty = stockQty \+ \?/i.test(s)) {
          bump(b[1], Number(b[0]));
          return { meta: { changes: 1 } };
        }
        if (/UPDATE wip_items SET stockQty = stockQty - \?/i.test(s)) {
          bump(b[1], -Number(b[0]));
          return { meta: { changes: 1 } };
        }
        if (/SET stockQty = GREATEST\(0, stockQty - \?\)/i.test(s)) {
          const code = b[2];
          const cur = wip.get(code) ?? 0;
          if (cur > 0) setQty(code, Math.max(0, cur - Number(b[0])));
          return { meta: { changes: 1 } };
        }
        if (/UPDATE wip_items SET stockQty = 0/i.test(s)) {
          if (wip.has(b[0])) setQty(b[0], 0);
          return { meta: { changes: 1 } };
        }
        throw new Error(`stub: unhandled SQL: ${s.slice(0, 120)}`);
      },
    };
    return obj;
  }

  return { prepare, wip, log };
}

// ---- Fixture: one bedframe PO, one chain, four stages -----------------------
// WOOD_CUT → FRAMING → WEBBING → UPHOLSTERY, all in one wipKey / one branch
// except UPHOLSTERY, which converges (branchKey ""), exactly as the real BOM
// emits them (see a live PO dump in the report for this change).
const PO = {
  id: "po-1",
  poNo: "SO-2608-001-01",
  quantity: 1,
  itemCategory: "BEDFRAME",
  productCode: "2038(A)-(SK)",
  specialOrder: null,
  fabricCode: "PC151-03",
  companySOId: "SO-2608-001",
  salesOrderId: null,
  companyCOId: null,
  consignmentOrderId: null,
};

function cards(statuses = {}) {
  const mk = (id, departmentCode, sequence, branchKey, wipLabel) => ({
    id,
    productionOrderId: PO.id,
    departmentCode,
    sequence,
    status: statuses[id] ?? "WAITING",
    wipKey: "chain-divan",
    wipCode: departmentCode,
    wipType: "DIVAN",
    wipLabel,
    wipQty: 1,
    branchKey,
  });
  return [
    mk("wd", "WOOD_CUT", 1, "b1", "Divan (WD)"),
    mk("fr", "FRAMING", 2, "b1", "Divan Frame"),
    mk("wb", "WEBBING", 3, "b1", "Divan Webbing"),
    mk("uph", "UPHOLSTERY", 4, "", "Divan"),
  ];
}

const byId = (list, id) => list.find((j) => j.id === id);

// Drive one status change through the real cascade.
async function move(db, list, id, to) {
  const jc = byId(list, id);
  const from = jc.status;
  jc.status = to;
  await applyWipInventoryChange(db, PO, jc, to, list, from, {
    orgId: ORG,
    source: "TEST",
  });
}

// ---------------------------------------------------------------------------
// FIX A
// ---------------------------------------------------------------------------
test("A: completing the last stage clears the upstream rows for that PO", async () => {
  const list = cards();
  const db = makeDb(list);

  // The floor cuts and frames, then SKIPS webbing and goes straight to
  // upholstery — the shape that left FAB_CUT holding 1,608 units on prod.
  await move(db, list, "wd", "COMPLETED");
  await move(db, list, "fr", "COMPLETED");
  assert.equal(db.wip.get("Divan (WD)"), 0, "framing consumed the wood cut");
  assert.equal(db.wip.get("Divan Frame"), 1, "framing's own output is on the shelf");

  await move(db, list, "uph", "COMPLETED");

  // The goods shipped. NOTHING may still be sitting in WIP for this PO.
  assert.equal(
    db.wip.get("Divan Frame"),
    0,
    "the skipped-past FRAMING row must be cleared by the last stage",
  );
  assert.equal(db.wip.get("Divan"), 0, "the last stage's own row nets to zero");
  assert.equal(db.wip.get("Divan (WD)"), 0);
});

test("A: the drain never touches a stage the floor never reported", async () => {
  const list = cards();
  const db = makeDb(list);
  // Only WOOD_CUT ran. FRAMING and WEBBING never happened, so they never put
  // anything in — draining them would invent stock that was never produced.
  await move(db, list, "wd", "COMPLETED");
  await move(db, list, "uph", "COMPLETED");
  assert.equal(db.wip.get("Divan (WD)"), 0, "the wood cut this PO added comes back out");
  assert.equal(
    db.wip.get("Divan Frame") ?? 0,
    0,
    "FRAMING never produced, so the drain must not subtract it",
  );
});

test("A: a PO still in progress keeps its WIP on the board", async () => {
  const list = cards();
  const db = makeDb(list);
  await move(db, list, "wd", "COMPLETED");
  assert.equal(
    db.wip.get("Divan (WD)"),
    1,
    "wood cut output stays visible until someone picks it up",
  );
});

// ---------------------------------------------------------------------------
// FIX B
// ---------------------------------------------------------------------------
test("B: a reverted-and-redone job card applies its decrement exactly once", async () => {
  const list = cards();
  const db = makeDb(list);

  await move(db, list, "wd", "COMPLETED");
  assert.equal(db.wip.get("Divan (WD)"), 1);

  // Complete FRAMING, revert it, complete it again — the exact sequence that
  // 792 job cards on prod went through.
  await move(db, list, "fr", "COMPLETED");
  assert.equal(db.wip.get("Divan (WD)"), 0, "framing consumed the wood cut");
  assert.equal(db.wip.get("Divan Frame"), 1);

  await move(db, list, "fr", "WAITING");
  assert.equal(db.wip.get("Divan (WD)"), 1, "the revert refunded the wood cut");
  assert.equal(db.wip.get("Divan Frame"), 0, "and took framing's own output back");

  await move(db, list, "fr", "COMPLETED");
  assert.equal(
    db.wip.get("Divan (WD)"),
    0,
    "the SECOND completion must consume the upstream again — this is the bug",
  );
  assert.equal(
    db.wip.get("Divan Frame"),
    1,
    "and must re-add its own output; leaving it at 0 is where the negatives came from",
  );
});

test("B: the same event applied twice changes nothing", async () => {
  const list = cards();
  const db = makeDb(list);
  await move(db, list, "wd", "COMPLETED");

  const jc = byId(list, "fr");
  jc.status = "COMPLETED";
  // Two callers replay the identical WAITING → COMPLETED (a retry, a backfill
  // re-firing, two operators racing the same card).
  await applyWipInventoryChange(db, PO, jc, "COMPLETED", list, "WAITING", {
    orgId: ORG,
    source: "TEST",
  });
  const after = new Map(db.wip);
  await applyWipInventoryChange(db, PO, jc, "COMPLETED", list, "WAITING", {
    orgId: ORG,
    source: "REPLAY",
  });
  assert.deepEqual(
    [...db.wip.entries()].sort(),
    [...after.entries()].sort(),
    "a replay of the last-applied transition must be a no-op",
  );
  assert.equal(db.wip.get("Divan (WD)"), 0, "consumed once, not twice");
  assert.equal(db.wip.get("Divan Frame"), 1, "added once, not twice");
});

test("B: complete → revert → complete on the LAST stage settles once, not twice", async () => {
  const list = cards();
  const db = makeDb(list);
  await move(db, list, "wd", "COMPLETED");
  await move(db, list, "fr", "COMPLETED");

  await move(db, list, "uph", "COMPLETED");
  assert.equal(db.wip.get("Divan Frame"), 0, "settle drained the orphaned framing");
  const afterFirstCompletion = [...db.wip.entries()].sort();

  await move(db, list, "uph", "WAITING");
  assert.equal(
    db.wip.get("Divan Frame"),
    1,
    "reverting the last stage puts the goods back into WIP",
  );

  await move(db, list, "uph", "COMPLETED");
  assert.equal(
    db.wip.get("Divan Frame"),
    0,
    "the re-completion drains it once more — never twice, which would go negative",
  );
  // The invariant that matters: a revert/redo round trip is a no-op on the
  // ledger. Every balance lands exactly where the first completion left it —
  // the settle applied once, the refund gave back exactly what it took.
  assert.deepEqual(
    [...db.wip.entries()].sort(),
    afterFirstCompletion,
    "a revert + redo of the last stage must leave every balance unchanged",
  );
});

// ---------------------------------------------------------------------------
// FIX C — a merged FAB_CUT card that cuts more than one piece.
//
// Option C merges the per-piece FAB_CUT cards into one card per (SO|PO,
// baseModel, fabric), because the cutter lays the bolt down once. That merged
// card's `wipQty` is the number of PIECES it covers — 2 for a divan-only
// bedframe, 3 for a three-piece sectional — and the producer adds exactly that
// to `wip_items`. The downstream consume is deduped to fire ONCE per merge
// group, and it used to take the literal 1, on the belief that a merged FC row
// counts sets. 337 of prod's 2,045 FAB_CUT cards carry more than 1, and each
// left `wipQty − 1` on the shelf permanently.
//
// The fixture is a divan-only bedframe PO, which is the majority shape: one
// merged FC card cutting 2 divans, one FAB_SEW card, one UPHOLSTERY.
// ---------------------------------------------------------------------------
const FC_PO = {
  ...PO,
  id: "po-fc",
  productCode: "DIVAN-(K)",
  fabricCode: "PC151-01",
};
const FC_LABEL = 'DIVAN-(K) | (6FT) | (10") | (DV 10") | PC151-01 | (FC)';

function fcCards(pieces = 2, statuses = {}) {
  return [
    {
      id: "fc",
      productionOrderId: FC_PO.id,
      departmentCode: "FAB_CUT",
      sequence: 0,
      status: statuses.fc ?? "WAITING",
      // The merged card's own one-card chain, keyed exactly as the aggregator
      // builds it for a BF/ACC per-PO merge.
      wipKey: `${FC_PO.id}::DIVAN-(K)::PC151-01::FAB_CUT`,
      wipCode: "FAB_CUT",
      wipType: "BEDFRAME",
      wipLabel: FC_LABEL,
      wipQty: pieces,
      branchKey: "",
    },
    {
      id: "sew",
      productionOrderId: FC_PO.id,
      departmentCode: "FAB_SEW",
      sequence: 1,
      status: statuses.sew ?? "WAITING",
      wipKey: "chain-divan",
      wipCode: "FAB_SEW",
      wipType: "DIVAN",
      wipLabel: "Divan Sewn",
      wipQty: pieces,
      branchKey: "b1",
    },
    {
      id: "uph",
      productionOrderId: FC_PO.id,
      departmentCode: "UPHOLSTERY",
      sequence: 2,
      status: statuses.uph ?? "WAITING",
      wipKey: "chain-divan",
      wipCode: "UPHOLSTERY",
      wipType: "DIVAN",
      wipLabel: "Divan",
      wipQty: pieces,
      branchKey: "",
    },
  ];
}

async function moveFc(db, list, id, to) {
  const jc = byId(list, id);
  const from = jc.status;
  jc.status = to;
  await applyWipInventoryChange(db, FC_PO, jc, to, list, from, {
    orgId: ORG,
    source: "TEST",
  });
}

test("C: the sew takes back everything the merged cut put in, not one piece of it", async () => {
  const list = fcCards(2);
  const db = makeDb(list);

  await moveFc(db, list, "fc", "COMPLETED");
  assert.equal(db.wip.get(FC_LABEL), 2, "the cutter cut two divans' worth");

  await moveFc(db, list, "sew", "COMPLETED");
  assert.equal(
    db.wip.get(FC_LABEL),
    0,
    "the cut stack has left the shelf — a leftover 1 here is the drift",
  );
  assert.equal(db.wip.get("Divan Sewn"), 2, "and the sew's own output is on it");
});

test("C: a three-piece sectional's cut clears completely too", async () => {
  const list = fcCards(3);
  const db = makeDb(list);
  await moveFc(db, list, "fc", "COMPLETED");
  await moveFc(db, list, "sew", "COMPLETED");
  assert.equal(db.wip.get(FC_LABEL), 0, "3 in, 3 out — not 3 in, 1 out");
});

test("C: a single-piece merged cut still balances, exactly as before", async () => {
  const list = fcCards(1);
  const db = makeDb(list);
  await moveFc(db, list, "fc", "COMPLETED");
  await moveFc(db, list, "sew", "COMPLETED");
  assert.equal(db.wip.get(FC_LABEL), 0, "the wipQty=1 case must not regress");
});

test("C: reverting the sew hands back exactly what it took", async () => {
  // The refund is the consume's inverse or it is a new drift. A round trip
  // has to land every balance back where the first completion left it —
  // refunding 1 against a consume of 2 would leave the row at −1, which is
  // the negative-balance failure mode.
  const list = fcCards(2);
  const db = makeDb(list);
  await moveFc(db, list, "fc", "COMPLETED");
  await moveFc(db, list, "sew", "COMPLETED");
  const afterFirst = [...db.wip.entries()].sort();

  await moveFc(db, list, "sew", "WAITING");
  assert.equal(db.wip.get(FC_LABEL), 2, "the whole cut stack is back on the shelf");
  assert.equal(db.wip.get("Divan Sewn"), 0);

  await moveFc(db, list, "sew", "COMPLETED");
  assert.deepEqual(
    [...db.wip.entries()].sort(),
    afterFirst,
    "revert + redo must be a no-op on the ledger",
  );
  assert.ok(
    [...db.wip.values()].every((q) => q >= 0),
    "and must never drive a row negative",
  );
});

test("C: the finished PO leaves nothing behind, and the books agree", async () => {
  const list = fcCards(2);
  const db = makeDb(list);
  await moveFc(db, list, "fc", "COMPLETED");
  await moveFc(db, list, "sew", "COMPLETED");
  await moveFc(db, list, "uph", "COMPLETED");

  for (const [code, qty] of db.wip) {
    assert.equal(qty, 0, `${code} still carries ${qty} on a shipped order`);
  }
  // And the independent derivation agrees with what the cascade wrote — the
  // whole point: `wip-expected.ts` says a card carries its OWN wipQty until a
  // downstream stage picks it up, which is the number the consume now takes.
  const r = reconcileWip(
    [FC_PO],
    list,
    [...db.wip.entries()].map(([code, stockQty]) => ({ code, stockQty })),
  );
  assert.equal(r.disagreeing, 0, "the ledger and the derivation must agree");
  assert.equal(r.netDiff, 0);
});

test("C: mid-flight, the derivation and the ledger agree on the cut stack", async () => {
  // Cut done, nothing downstream started: both say the pieces are on the shelf.
  const list = fcCards(2);
  const db = makeDb(list);
  await moveFc(db, list, "fc", "COMPLETED");
  const r = reconcileWip(
    [FC_PO],
    list,
    [...db.wip.entries()].map(([code, stockQty]) => ({ code, stockQty })),
  );
  assert.equal(db.wip.get(FC_LABEL), 2);
  assert.equal(r.disagreeing, 0, "2 cut, 2 expected — not 1");
});

// ---------------------------------------------------------------------------
// The reconciliation
// ---------------------------------------------------------------------------
test("reconcile: silent when the books agree", () => {
  const list = cards({ wd: "COMPLETED" });
  const r = reconcileWip([PO], list, [{ code: "Divan (WD)", stockQty: 1 }]);
  assert.equal(r.disagreeing, 0);
  assert.equal(r.rows.length, 0);
  assert.equal(r.netDiff, 0);
});

test("reconcile: reports the stale upstream row a finished PO left behind", () => {
  // Every stage done → the order shipped → expected WIP is zero, but the
  // ledger still carries the framing row.
  const list = cards({
    wd: "COMPLETED",
    fr: "COMPLETED",
    wb: "COMPLETED",
    uph: "COMPLETED",
  });
  const r = reconcileWip([PO], list, [{ code: "Divan Frame", stockQty: 3 }]);
  assert.equal(r.disagreeing, 1);
  assert.deepEqual(r.rows[0], {
    code: "Divan Frame",
    storedQty: 3,
    expectedQty: 0,
    diff: 3,
  });
  assert.equal(r.overstatedUnits, 3);
  assert.equal(r.understatedUnits, 0);
});

test("reconcile: reports a physically impossible negative row", () => {
  const list = cards({ wd: "COMPLETED" });
  const r = reconcileWip([PO], list, [
    { code: "Divan (WD)", stockQty: 1 },
    { code: "Divan Webbing", stockQty: -4 },
  ]);
  assert.equal(r.negativeStoredRows, 1);
  assert.equal(r.understatedUnits, 4);
  assert.deepEqual(
    r.rows.map((x) => x.code),
    ["Divan Webbing"],
  );
});

test("reconcile: a code shared by two POs is judged on BOTH their histories", () => {
  // One PO finished (contributes nothing), one still mid-chain (contributes 1).
  const po2 = { ...PO, id: "po-2" };
  const listA = cards({ wd: "COMPLETED", fr: "COMPLETED", wb: "COMPLETED", uph: "COMPLETED" });
  const listB = cards({ wd: "COMPLETED" }).map((j) => ({
    ...j,
    id: `${j.id}-2`,
    productionOrderId: "po-2",
  }));
  const r = reconcileWip([PO, po2], [...listA, ...listB], [
    { code: "Divan (WD)", stockQty: 7 },
  ]);
  assert.equal(r.rows[0].expectedQty, 1, "only the live PO justifies stock");
  assert.equal(r.rows[0].diff, 6);
});
