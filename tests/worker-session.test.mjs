import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKER_ME_KEY,
  WORKER_TOKEN_KEY,
  getWorkerToken,
  workerFetch,
} from "../src/lib/worker-session.ts";

test("worker session helper preserves auth headers and clears a rejected session", async () => {
  const originals = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
  };
  const stored = new Map([
    [WORKER_TOKEN_KEY, "worker-token"],
    [WORKER_ME_KEY, '{"id":"w-1"}'],
  ]);
  let requestInit;
  const events = [];

  globalThis.localStorage = {
    getItem(key) {
      return stored.get(key) ?? null;
    },
    removeItem(key) {
      stored.delete(key);
    },
  };
  globalThis.window = {
    dispatchEvent(event) {
      events.push(event.type);
      return true;
    },
  };
  globalThis.fetch = async (_input, init) => {
    requestInit = init;
    return new Response(null, { status: 401 });
  };

  try {
    assert.equal(getWorkerToken(), "worker-token");
    const response = await workerFetch("/api/worker/today", {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal(requestInit.headers.get("X-Worker-Token"), "worker-token");
    assert.equal(requestInit.headers.get("Content-Type"), "application/json");
    assert.equal(stored.has(WORKER_TOKEN_KEY), false);
    assert.equal(stored.has(WORKER_ME_KEY), false);
    assert.deepEqual(events, ["storage"]);
  } finally {
    globalThis.fetch = originals.fetch;
    if (originals.localStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originals.localStorage;
    if (originals.window === undefined) delete globalThis.window;
    else globalThis.window = originals.window;
  }
});
