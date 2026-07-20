import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  fingerprintRequest,
  withIdempotency,
} from "../src/api/lib/idempotency.ts";

function recordKey(orgId, resource, key) {
  return `${orgId}\u0000${resource}\u0000${key}`;
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async first() {
    if (this.sql.includes("INSERT INTO api_idempotency_keys")) {
      const [orgId, resource, key, requestHash, ownerToken] = this.params;
      const k = recordKey(orgId, resource, key);
      if (this.db.rows.has(k)) return null;
      this.db.rows.set(k, {
        request_hash: requestHash,
        owner_token: ownerToken,
        state: "pending",
        expiresAt: Date.now() + 300_000,
      });
      return { owner_token: ownerToken };
    }
    if (this.sql.includes("FROM api_idempotency_keys")) {
      const [orgId, resource, key] = this.params;
      return this.db.rows.get(recordKey(orgId, resource, key)) ?? null;
    }
    throw new Error(`Unexpected first SQL: ${this.sql}`);
  }

  async run() {
    if (this.sql.startsWith("CREATE ")) return { success: true };

    if (this.sql.includes("DELETE FROM api_idempotency_keys")) {
      if (this.params.length === 0) {
        for (const [key, row] of this.db.rows) {
          if (row.expiresAt <= Date.now()) this.db.rows.delete(key);
        }
        return { success: true };
      }
      const [orgId, resource, key, ownerToken] = this.params;
      const k = recordKey(orgId, resource, key);
      const row = this.db.rows.get(k);
      if (!row) return { success: true };
      if (this.sql.includes("owner_token = ?")) {
        if (row.owner_token === ownerToken && row.state === "pending") {
          this.db.rows.delete(k);
        }
      } else if (row.expiresAt <= Date.now()) {
        this.db.rows.delete(k);
      }
      return { success: true };
    }

    if (this.sql.includes("UPDATE api_idempotency_keys")) {
      const [status, body, contentType, orgId, resource, key, ownerToken] = this.params;
      const row = this.db.rows.get(recordKey(orgId, resource, key));
      if (row?.owner_token === ownerToken && row.state === "pending") {
        Object.assign(row, {
          state: "complete",
          response_status: status,
          response_body: body,
          response_content_type: contentType,
          expiresAt: Date.now() + 86_400_000,
        });
      }
      return { success: true };
    }
    throw new Error(`Unexpected run SQL: ${this.sql}`);
  }
}

class FakeDb {
  rows = new Map();

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

const CLAIM = {
  orgId: "hookka",
  resource: "invoices",
  key: "retry-1",
  requestHash: "hash-a",
};

test("the database primary key lets exactly one concurrent claim win", async () => {
  const db = new FakeDb();
  const claims = await Promise.all([
    claimIdempotencyKey(db, CLAIM),
    claimIdempotencyKey(db, CLAIM),
  ]);
  assert.equal(claims.filter(({ kind }) => kind === "claimed").length, 1);
  assert.equal(claims.filter(({ kind }) => kind === "pending").length, 1);
});

test("complete claims replay, changed payloads conflict, tenants stay isolated", async () => {
  const db = new FakeDb();
  const first = await claimIdempotencyKey(db, CLAIM);
  assert.equal(first.kind, "claimed");
  await completeIdempotencyKey(db, {
    ...CLAIM,
    ownerToken: first.ownerToken,
    status: 201,
    body: JSON.stringify({ id: "INV-1" }),
    contentType: "application/json",
  });

  const replay = await claimIdempotencyKey(db, CLAIM);
  assert.deepEqual(replay, {
    kind: "replay",
    status: 201,
    body: JSON.stringify({ id: "INV-1" }),
    contentType: "application/json",
  });
  assert.equal(
    (await claimIdempotencyKey(db, { ...CLAIM, requestHash: "hash-b" })).kind,
    "conflict",
  );
  assert.equal(
    (await claimIdempotencyKey(db, { ...CLAIM, orgId: "tenant-b" })).kind,
    "claimed",
  );
});

test("request fingerprint binds method, path, query and payload", async () => {
  const a = await fingerprintRequest(
    new Request("https://erp.test/api/invoices?mode=do", {
      method: "POST",
      body: JSON.stringify({ deliveryOrderId: "DO-1" }),
    }),
  );
  const b = await fingerprintRequest(
    new Request("https://erp.test/api/invoices?mode=do", {
      method: "POST",
      body: JSON.stringify({ deliveryOrderId: "DO-1" }),
    }),
  );
  const changed = await fingerprintRequest(
    new Request("https://erp.test/api/invoices?mode=do", {
      method: "POST",
      body: JSON.stringify({ deliveryOrderId: "DO-2" }),
    }),
  );
  assert.equal(a, b);
  assert.notEqual(a, changed);
});

test("withIdempotency executes a same-key mutation once and replays it", async () => {
  const db = new FakeDb();
  let writes = 0;
  const makeContext = () => ({
    req: {
      raw: new Request("https://erp.test/api/invoices", {
        method: "POST",
        body: JSON.stringify({ deliveryOrderId: "DO-1" }),
      }),
    },
    var: { DB: db },
    get: (key) => (key === "orgId" ? "hookka" : undefined),
  });
  const handler = async () => {
    writes += 1;
    return Response.json({ id: "INV-1" }, { status: 201 });
  };

  const first = await withIdempotency(makeContext(), "invoices", "same-key", handler);
  const second = await withIdempotency(makeContext(), "invoices", "same-key", handler);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.headers.get("idempotency-replay"), "true");
  assert.equal(writes, 1);
});

test("replaying an empty success response does not attach an illegal body", async () => {
  const db = new FakeDb();
  const makeContext = () => ({
    req: {
      raw: new Request("https://erp.test/api/invoices/INV-1", {
        method: "POST",
        body: "{}",
      }),
    },
    var: { DB: db },
    get: (key) => (key === "orgId" ? "hookka" : undefined),
  });
  const handler = async () => new Response(null, { status: 204 });

  await withIdempotency(makeContext(), "invoices", "empty-response", handler);
  const replay = await withIdempotency(
    makeContext(),
    "invoices",
    "empty-response",
    handler,
  );
  assert.equal(replay.status, 204);
  assert.equal(await replay.text(), "");
});

test("runtime self-apply and migration define the same columns and primary key", () => {
  const runtime = readFileSync("src/api/lib/idempotency.ts", "utf8");
  const migration = readFileSync("migrations-postgres/0208_api_idempotency.sql", "utf8");
  const expectedColumns = [
    "org_id",
    "resource",
    "idem_key",
    "request_hash",
    "owner_token",
    "state",
    "response_status",
    "response_body",
    "response_content_type",
    "created_at",
    "expires_at",
  ];
  for (const column of expectedColumns) {
    assert.match(runtime, new RegExp(`\\b${column}\\b`));
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  for (const source of [runtime, migration]) {
    assert.match(source, /PRIMARY KEY \(org_id, resource, idem_key\)/);
  }
});
