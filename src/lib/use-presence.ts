// ---------------------------------------------------------------------------
// usePresence — signals "I'm editing {recordType}:{recordId}" to the server
// and returns the list of OTHER active editors for the same record.
//
// Heartbeat every 30s while the hook is mounted.
// Poll for others every 10s.
// Release (DELETE) on unmount or when the tab goes away.
//
// Silently no-ops if the user isn't signed in.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { getAuthToken } from "./auth";

export type PresenceHolder = {
  userId: string;
  displayName: string;
  acquiredAt: string;
  heartbeatAt: string;
};

const HEARTBEAT_MS = 30_000;
const POLL_MS = 10_000;

function authHeaders(): HeadersInit {
  const t = getAuthToken();
  return {
    "content-type": "application/json",
    ...(t ? { authorization: `Bearer ${t}` } : {}),
  };
}

async function heartbeat(recordType: string, recordId: string): Promise<void> {
  try {
    await fetch("/api/presence", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ recordType, recordId }),
      keepalive: true,
    });
  } catch {
    // transient network error — next heartbeat will retry
  }
}

async function release(recordType: string, recordId: string): Promise<void> {
  try {
    await fetch("/api/presence", {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({ recordType, recordId }),
      keepalive: true,
    });
  } catch {
    // best-effort
  }
}

async function listOthers(
  recordType: string,
  recordId: string,
): Promise<PresenceHolder[]> {
  try {
    const q = new URLSearchParams({ recordType, recordId });
    const res = await fetch(`/api/presence?${q}`, { headers: authHeaders() });
    if (!res.ok) return [];
    const j = (await res.json()) as { success: boolean; data?: PresenceHolder[] };
    return Array.isArray(j.data) ? j.data : [];
  } catch {
    return [];
  }
}

/**
 * `enabled=false` lets callers conditionally disable (e.g. for new/unsaved
 * records that don't have a stable id yet). When disabled the hook does
 * nothing and returns an empty holders list.
 */
export function usePresence(
  recordType: string,
  recordId: string | null | undefined,
  enabled: boolean = true,
): PresenceHolder[] {
  const [others, setOthers] = useState<PresenceHolder[]>([]);
  const activeRef = useRef(false);

  useEffect(() => {
    if (!enabled || !recordId || !recordType) {
      setOthers([]);
      return;
    }
    if (!getAuthToken()) return;

    activeRef.current = true;
    let hbTimer: number | undefined;
    let pollTimer: number | undefined;

    async function tickHeartbeat() {
      if (!activeRef.current) return;
      await heartbeat(recordType, recordId!);
    }
    async function tickPoll() {
      if (!activeRef.current) return;
      const list = await listOthers(recordType, recordId!);
      if (activeRef.current) setOthers(list);
    }

    // kick off immediately
    tickHeartbeat();
    tickPoll();
    hbTimer = window.setInterval(tickHeartbeat, HEARTBEAT_MS);
    pollTimer = window.setInterval(tickPoll, POLL_MS);

    // release when the browser tab closes — keepalive on the DELETE ensures
    // the request is still sent in unload scenarios.
    function onUnload() {
      release(recordType, recordId!);
    }
    window.addEventListener("pagehide", onUnload);

    return () => {
      activeRef.current = false;
      if (hbTimer) window.clearInterval(hbTimer);
      if (pollTimer) window.clearInterval(pollTimer);
      window.removeEventListener("pagehide", onUnload);
      release(recordType, recordId);
    };
  }, [recordType, recordId, enabled]);

  return others;
}
