// ---------------------------------------------------------------------------
// customer-stage-self-apply-retry.test.mjs — BUG-CLASS C9 regression.
//
// ensureCustomerStageColumns runs the ONLY thing that puts customer_stage +
// salesperson_user_id into prod (migrations are inert on deploy — CLAUDE.md).
// The old shape set its boolean memo PAST the catch, so a transient DDL blip on
// the first write after an isolate boots was remembered as "done": the columns
// stayed missing and every later customer PUT — whose UPDATE references both —
// 500s, silently dropping the whole save (OEM marking, phone, name).
//
// The generic self-apply-memo-is-boolean.test.mjs does NOT catch this variant:
// it only checks that *some* await precedes the setter, which the buggy shape
// satisfies. This test proves the behaviour: a failed round must NOT stick.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { ensureCustomerStageColumns } from "../src/api/lib/customer-stage.ts";

/** Minimal D1-ish stub. `throwOnRun` fails every .run(); otherwise counts them. */
function makeDb(throwOnRun) {
  const state = { prepares: 0, runs: 0 };
  const db = {
    prepare(_sql) {
      state.prepares++;
      return {
        run: async () => {
          state.runs++;
          if (throwOnRun) throw new Error("simulated transient DDL failure");
          return { success: true };
        },
        bind() {
          return this;
        },
      };
    },
  };
  return { db, state };
}

test("a failed ALTER round is retried, not memoised as done (C9)", async () => {
  // Round 1: the DDL blips. The guard must swallow it AND leave the memo unset.
  const failing = makeDb(true);
  await ensureCustomerStageColumns(failing.db);
  assert.ok(failing.state.runs >= 1, "round 1 should have attempted the ALTER");

  // Round 2: a healthy connection. If the failure had stuck, this returns early
  // and the columns are never created — the exact production symptom.
  const ok = makeDb(false);
  await ensureCustomerStageColumns(ok.db);
  assert.ok(
    ok.state.runs >= 2,
    "round 2 must actually run BOTH ALTERs (customer_stage + salesperson_user_id) — " +
      "a memoised failure would skip them and leave the columns missing",
  );
});

test("once the columns land the memo sticks — no repeated ALTER per request", async () => {
  // The success round above already set the memo; a further call must be a no-op.
  const again = makeDb(false);
  await ensureCustomerStageColumns(again.db);
  assert.equal(
    again.state.runs,
    0,
    "a landed self-apply must not re-run its DDL on every subsequent request",
  );
});
