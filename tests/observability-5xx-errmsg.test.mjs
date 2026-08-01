// ---------------------------------------------------------------------------
// observability-5xx-errmsg.test.mjs
//
// The health dashboard showed 26 five-hundreds in 24h on 2026-08-01 with EVERY
// errMsg empty — so no 500 could be root-caused from the dashboard at all.
//
// Cause: timingMiddleware only captured a message when the handler THREW.
// 137 call sites across src/api instead do
//     return c.json({ success:false, error:"..." }, 500)
// which never throws, so errMsg stayed "" while the row still counted as 5xx.
//
// These tests drive the real middleware with a fake Analytics Engine and assert
// the blob6 (errMsg) slot actually carries text for the RETURNED case — the
// exact shape that was silently losing it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import */
}

// Minimal Hono-ish context. Only what timingMiddleware touches.
function makeCtx(res, { url = "https://x/api/thing", method = "POST" } = {}) {
  const written = [];
  return {
    ctx: {
      req: { url, method, header: () => undefined },
      res,
      env: {
        ENVIRONMENT: "production",
        ERP_METRICS: { writeDataPoint: (d) => written.push(d) },
      },
      var: {},
      set() {},
      get() {},
    },
    written,
  };
}

const reqPoint = (written) =>
  written.find((d) => Array.isArray(d.blobs) && d.blobs[0] === "req");

test("a RETURNED 500 carries its error text into blob6", async () => {
  const { timingMiddleware } = await import("../src/api/lib/observability.ts");
  const res = new Response(
    JSON.stringify({ success: false, error: "consignment status row missing" }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
  const { ctx, written } = makeCtx(res);
  await timingMiddleware(ctx, async () => {});

  const p = reqPoint(written);
  assert.ok(p, "a req data point must be written");
  assert.equal(p.blobs[2], "500");
  assert.equal(
    p.blobs[5],
    "consignment status row missing",
    "blob6 must carry the returned body's error — this is the bug that made every 500 blank",
  );
});

test("the response the client receives is NOT consumed by the capture", async () => {
  const { timingMiddleware } = await import("../src/api/lib/observability.ts");
  const res = new Response(JSON.stringify({ success: false, error: "boom" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
  const { ctx } = makeCtx(res);
  await timingMiddleware(ctx, async () => {});
  // clone() must have been used — the original body is still readable.
  const body = await ctx.res.json();
  assert.equal(body.error, "boom", "reading telemetry must not eat the response");
});

test("a THROWN error still wins (existing path untouched)", async () => {
  const { timingMiddleware } = await import("../src/api/lib/observability.ts");
  const { ctx, written } = makeCtx(new Response("", { status: 200 }));
  // The middleware records the throw, then RE-THROWS so Hono's onError still
  // produces the response. Both halves matter: the metric must be written AND
  // the error must keep propagating.
  await assert.rejects(
    () =>
      timingMiddleware(ctx, async () => {
        throw new Error("thrown path still works");
      }),
    /thrown path still works/,
    "the error must still propagate to Hono's onError",
  );
  const p = reqPoint(written);
  assert.equal(p.blobs[2], "500", "a throw is counted as 500");
  assert.equal(p.blobs[5], "thrown path still works");
});

test("2xx and 4xx are left alone — no body read, no message", async () => {
  const { timingMiddleware } = await import("../src/api/lib/observability.ts");

  for (const [status, label] of [[200, "2xx"], [400, "4xx"], [404, "4xx"]]) {
    const res = new Response(JSON.stringify({ error: "should not be captured" }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    const { ctx, written } = makeCtx(res);
    await timingMiddleware(ctx, async () => {});
    const p = reqPoint(written);
    assert.equal(p.blobs[5], "", `${label} (${status}) must not capture a message`);
  }
});

test("non-JSON and unreadable 5xx bodies degrade safely", async () => {
  const { timingMiddleware } = await import("../src/api/lib/observability.ts");

  // Plain-text / HTML error page → keep a snippet rather than crashing.
  const html = new Response("<html>Internal Server Error</html>", { status: 502 });
  const a = makeCtx(html);
  await timingMiddleware(a.ctx, async () => {});
  assert.match(reqPoint(a.written).blobs[5], /Internal Server Error/);

  // A body that throws on read must not break the request or the metric.
  const hostile = {
    status: 503,
    clone() {
      return { text: async () => { throw new Error("stream gone"); } };
    },
    headers: new Headers(),
  };
  const b = makeCtx(hostile);
  await timingMiddleware(b.ctx, async () => {});
  const p = reqPoint(b.written);
  assert.ok(p, "metric still written when the body cannot be read");
  assert.equal(p.blobs[5], "", "unreadable body leaves the message empty, no throw");
});

test("captured text is truncated to the 200-char budget", async () => {
  const { timingMiddleware } = await import("../src/api/lib/observability.ts");
  const long = "x".repeat(500);
  const res = new Response(JSON.stringify({ error: long }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
  const { ctx, written } = makeCtx(res);
  await timingMiddleware(ctx, async () => {});
  assert.equal(reqPoint(written).blobs[5].length, 200);
});
