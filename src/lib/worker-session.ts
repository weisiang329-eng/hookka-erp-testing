// Worker portal session primitives deliberately live outside WorkerLayout.
// Keeping these helpers in the React layout made every worker page import the
// whole layout and prevented the /worker-only shell from being lazy-loaded.

export const WORKER_TOKEN_KEY = "hookka.worker.token";
export const WORKER_ME_KEY = "hookka.worker.me";

export type WorkerMe = {
  id: string;
  empNo: string;
  name: string;
  departmentCode: string;
  position?: string;
  phone?: string;
  nationality?: string;
};

export function getWorkerToken(): string | null {
  try {
    return localStorage.getItem(WORKER_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearWorkerAuth() {
  try {
    localStorage.removeItem(WORKER_TOKEN_KEY);
    localStorage.removeItem(WORKER_ME_KEY);
  } catch {
    /* storage can be unavailable in private/restricted browser contexts */
  }
}

export async function workerFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getWorkerToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Worker-Token", token);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    clearWorkerAuth();
    // Let the caller inspect the 401; the layout listens for this event and
    // performs the portal-specific redirect without affecting office auth.
    window.dispatchEvent(new Event("storage"));
  }
  return response;
}

export function readWorkerMe(): WorkerMe | null {
  try {
    const raw = localStorage.getItem(WORKER_ME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkerMe;
    if (parsed && typeof parsed === "object" && parsed.id && parsed.empNo) {
      return parsed;
    }
  } catch {
    /* malformed or inaccessible storage is an unauthenticated state */
  }
  return null;
}
