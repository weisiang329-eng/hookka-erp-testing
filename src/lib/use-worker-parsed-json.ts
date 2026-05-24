// Worker-parsed JSON hook — Phase 5 of the Production performance refactor.
//
// Drop-in replacement for the relevant useCachedJson use sites where the
// response payload is large enough that JSON.parse on the main thread
// stalls paint (currently /api/production-orders, which decompresses to
// ~2.6-4 MB even after the Phase 4 slim).
//
// Pipeline:
//   1. fetch(url) → Response
//   2. await response.arrayBuffer()   ← cheap byte copy, ~10 ms main thread
//   3. transfer the ArrayBuffer into a dedicated parse worker
//   4. worker: TextDecoder + JSON.parse  ← ~150-200 ms off-thread
//   5. structured-clone the parsed object back to the main thread
//      (~50-80 ms on a 4 MB object graph)
//
// Net: shaves ~100-150 ms of main-thread blocking per fetch versus the
// useCachedJson default. The page wraps this hook in the same usage
// pattern: `const { data, loading, refresh } = useWorkerParsedJson<T>(url)`.
//
// The parse worker itself is a singleton — first usage instantiates,
// subsequent fetches reuse. Each fetch carries a monotonic reqId so a
// later post supersedes earlier in-flight parses (the older response is
// dropped instead of flashing into the UI).

import { useEffect, useRef, useState, useCallback } from "react";

import ParseWorker from "../pages/production/parse.worker.ts?worker";
import type { ParseRequest, ParseResponse } from "../pages/production/parse.worker";

type Result<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

// One worker instance shared across all callers in the process. Cleaned
// up on hard navigation (browser handles it). Lazy-instantiated so a page
// that never calls the hook doesn't pay the worker startup cost.
let sharedWorker: Worker | null = null;
let sharedNextReqId = 0;
const pendingResolvers = new Map<number, (data: unknown) => void>();

function ensureWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  sharedWorker = new ParseWorker();
  sharedWorker.onmessage = (e: MessageEvent<ParseResponse>) => {
    const { reqId, data } = e.data;
    const resolver = pendingResolvers.get(reqId);
    if (!resolver) return;
    pendingResolvers.delete(reqId);
    resolver(data);
  };
  return sharedWorker;
}

function parseInWorker(body: ArrayBuffer): Promise<unknown> {
  const worker = ensureWorker();
  const reqId = ++sharedNextReqId;
  return new Promise((resolve) => {
    pendingResolvers.set(reqId, resolve);
    const msg: ParseRequest = { reqId, body };
    worker.postMessage(msg, [body]); // transferable — zero-copy
  });
}

export function useWorkerParsedJson<T = unknown>(
  url: string | null,
): Result<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Tracks the latest fetch sequence per hook instance so stale responses
  // (operator hit a new dept tab before the previous parse resolved) are
  // dropped instead of clobbering the newer data.
  const seqRef = useRef(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  /* eslint-disable react-hooks/set-state-in-effect -- url=null reset path mirrors useCachedJson; setLoading is the documented "starting an async operation" hand-off, the rest happens in .then() callbacks */
  useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const mySeq = ++seqRef.current;
    setLoading(true);
    setError(null);
    let cancelled = false;
    const t0 = performance.now();
    fetch(url, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        return parseInWorker(buf);
      })
      .then((parsed) => {
        if (cancelled || mySeq !== seqRef.current) return;
        const dur = Math.round(performance.now() - t0);
        if (dur >= 500) {
          console.warn(`[useWorkerParsedJson] slow url=${url} dur_ms=${dur}`);
        }
        setData(parsed as T);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || mySeq !== seqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url, tick]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { data, loading, error, refresh };
}
