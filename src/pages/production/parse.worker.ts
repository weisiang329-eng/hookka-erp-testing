// JSON parse worker — Phase 5 of the Production performance refactor.
//
// The Production page's /api/production-orders response decompresses to
// ~2.6-4 MB JSON. Parsing that on the main thread blocks paint for
// 100-200 ms on every tab switch / refresh — visible to the operator as a
// "click → frozen ▒ ▒ ▒ → grid pops in" stutter.
//
// This worker receives the response body as an ArrayBuffer (zero-copy
// transferable, so the post itself costs ~0 main-thread time), decodes
// UTF-8, runs JSON.parse off-thread, and posts the parsed object back.
// The main thread's only cost is now (a) `await response.arrayBuffer()`
// (~10 ms — just byte copy from the decompressed stream) plus
// (b) structured clone of the parsed object back (~50-80 ms for
// 1000-row payloads, vs ~150-200 ms for synchronous JSON.parse).
//
// Net main-thread saving on the slim post-Phase-4 payload: ~100-150 ms
// per fetch.
export type ParseRequest = {
  reqId: number;
  // Transferable — main thread gives up ownership when it postMessages.
  body: ArrayBuffer;
};

export type ParseResponse = {
  reqId: number;
  // The parsed JSON value. Shape is whatever the API returned; the page
  // consumer narrows the type via its own assertion.
  data: unknown;
  // Worker-side parse duration in ms, for the page's perf bookkeeping.
  parseMs: number;
};

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { reqId, body } = e.data;
  const t0 = performance.now();
  const text = new TextDecoder("utf-8").decode(body);
  const data = JSON.parse(text);
  const parseMs = Math.round(performance.now() - t0);
  const response: ParseResponse = { reqId, data, parseMs };
  ctx.postMessage(response);
};
