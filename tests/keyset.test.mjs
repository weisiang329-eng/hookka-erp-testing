import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeKeysetCursor,
  decodeKeysetCursor,
  keysetPage,
  keysetResult,
} from "../src/api/lib/keyset.ts";

test("cursor encode/decode round-trips (URL-safe, no padding)", () => {
  const c = { createdAt: "2026-07-13T10:20:30.456Z", id: "do-fc0c8756" };
  const enc = encodeKeysetCursor(c);
  assert.match(enc, /^[A-Za-z0-9_-]+$/); // URL-safe, no + / =
  assert.deepEqual(decodeKeysetCursor(enc), c);
});

test("decode tolerates junk / empty → null", () => {
  assert.equal(decodeKeysetCursor(null), null);
  assert.equal(decodeKeysetCursor(""), null);
  assert.equal(decodeKeysetCursor("!!!not-base64!!!"), null);
  // base64 of a string with no separator → null (can't split time|id)
  assert.equal(decodeKeysetCursor(btoa("nosep")), null);
});

test("keysetPage: first page has no WHERE, binds only LIMIT = take+1", () => {
  const p = keysetPage(null, 50);
  assert.equal(p.where, "");
  assert.equal(p.take, 50);
  assert.deepEqual(p.params, [51]);
  assert.match(p.tail, /ORDER BY created_at DESC, id DESC LIMIT \?$/);
});

test("keysetPage: with cursor emits the expanded OR tiebreak form + ordered params", () => {
  const cur = { createdAt: "2026-07-01T00:00:00Z", id: "do-9" };
  const p = keysetPage(cur, 200);
  assert.equal(
    p.where,
    " AND (created_at < ? OR (created_at = ? AND id < ?))",
  );
  // params order matches the ? order in where + tail
  assert.deepEqual(p.params, [cur.createdAt, cur.createdAt, cur.id, 201]);
});

test("keysetPage: take clamped to 1..1000; custom columns honoured", () => {
  assert.equal(keysetPage(null, 0).take, 1);
  assert.equal(keysetPage(null, 99999).take, 1000);
  const p = keysetPage({ createdAt: "t", id: "i" }, 10, {
    timeCol: "issued_at",
    idCol: "no",
  });
  assert.equal(p.where, " AND (issued_at < ? OR (issued_at = ? AND no < ?))");
  assert.match(p.tail, /ORDER BY issued_at DESC, no DESC LIMIT \?$/);
});

test("keysetResult: lookahead row drives hasMore + nextCursor", () => {
  const rows = [
    { id: "a", created_at: "2026-07-03T00:00:00Z" },
    { id: "b", created_at: "2026-07-02T00:00:00Z" },
    { id: "c", created_at: "2026-07-01T00:00:00Z" }, // the +1 lookahead
  ];
  const { items, nextCursor } = keysetResult(rows, 2, (r) => r.created_at);
  assert.deepEqual(
    items.map((r) => r.id),
    ["a", "b"],
  );
  assert.deepEqual(decodeKeysetCursor(nextCursor), {
    createdAt: "2026-07-02T00:00:00Z",
    id: "b",
  });
});

test("keysetResult: last page → nextCursor null", () => {
  const rows = [{ id: "a", created_at: "2026-07-03T00:00:00Z" }];
  const { items, nextCursor } = keysetResult(rows, 2, (r) => r.created_at);
  assert.equal(items.length, 1);
  assert.equal(nextCursor, null);
});

// -------------------------------------------------------------------------
// Prevention checklist #4 (owner's #1 fear): rows sharing a timestamp across a
// page boundary must NOT be skipped or duplicated. Simulate the exact SQL
// predicate the cursor produces and page through a dataset full of ties.
// -------------------------------------------------------------------------
test("no skipped/duplicated rows on timestamp ties across page boundaries", () => {
  // 10 rows, many sharing created_at, unique ids. Sorted the way the query
  // returns them: created_at DESC, id DESC.
  const all = [
    { id: "i9", created_at: "2026-07-03T00:00:00Z" },
    { id: "i8", created_at: "2026-07-02T00:00:00Z" },
    { id: "i7", created_at: "2026-07-02T00:00:00Z" }, // tie
    { id: "i6", created_at: "2026-07-02T00:00:00Z" }, // tie
    { id: "i5", created_at: "2026-07-02T00:00:00Z" }, // tie
    { id: "i4", created_at: "2026-07-01T00:00:00Z" },
    { id: "i3", created_at: "2026-07-01T00:00:00Z" }, // tie
    { id: "i2", created_at: "2026-07-01T00:00:00Z" }, // tie
    { id: "i1", created_at: "2026-06-30T00:00:00Z" },
    { id: "i0", created_at: "2026-06-30T00:00:00Z" }, // tie
  ].sort((a, b) =>
    a.created_at < b.created_at
      ? 1
      : a.created_at > b.created_at
        ? -1
        : a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0,
  );

  // JS mirror of the SQL keyset WHERE the helper emits:
  //   created_at < cur OR (created_at = cur AND id < curId)   (DESC order)
  const applyCursor = (rows, cur) =>
    !cur
      ? rows
      : rows.filter(
          (r) =>
            r.created_at < cur.createdAt ||
            (r.created_at === cur.createdAt && r.id < cur.id),
        );

  const PAGE = 3;
  const seen = [];
  let cursor = null;
  let guard = 0;
  for (;;) {
    if (++guard > 50) throw new Error("pagination did not terminate");
    const page = keysetPage(cursor, PAGE);
    const eligible = applyCursor(all, cursor); // already in DESC order
    const fetched = eligible.slice(0, page.take + 1); // +1 lookahead
    const { items, nextCursor } = keysetResult(
      fetched,
      page.take,
      (r) => r.created_at,
    );
    seen.push(...items.map((r) => r.id));
    if (!nextCursor) break;
    cursor = decodeKeysetCursor(nextCursor);
  }

  // Every row seen exactly once, in the exact full order — no drops, no dupes.
  assert.deepEqual(
    seen,
    all.map((r) => r.id),
  );
  assert.equal(new Set(seen).size, all.length);
});
