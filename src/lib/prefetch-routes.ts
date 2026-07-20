import { prefetchRoute } from "../dashboard-routes";
import { buildRoutePrefetchPlan } from "./prefetch-policy";

type NetworkInformation = {
  saveData?: boolean;
  effectiveType?: string;
};

type Scheduling = {
  isInputPending?: () => boolean;
};

type PrefetchNavigator = Navigator & {
  connection?: NetworkInformation;
  deviceMemory?: number;
  scheduling?: Scheduling;
};

type PrefetchOptions = {
  pathname: string;
  role?: string | null;
};

function runtimeAllowsPrefetch(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (window.matchMedia?.("(pointer: coarse)").matches) return false;

  const nav = navigator as PrefetchNavigator;
  const connection = nav.connection;
  if (connection?.saveData) return false;
  if (["slow-2g", "2g", "3g"].includes(connection?.effectiveType ?? "")) return false;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 2) return false;
  return true;
}

function inputIsPending(): boolean {
  return Boolean((navigator as PrefetchNavigator).scheduling?.isInputPending?.());
}

function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(callback);
    return () => window.cancelIdleCallback(id);
  }
  // eslint-disable-next-line no-restricted-syntax -- non-React cancellable fallback for requestIdleCallback
  const id = window.setTimeout(callback, 1500);
  return () => window.clearTimeout(id);
}

/**
 * Prefetch only the next high-probability page chunks for the current workflow.
 * Route changes cancel the old queue; sidebar hover/focus remains the stronger
 * intent signal for every other page.
 */
export function prefetchRoutesWhenIdle({ pathname, role }: PrefetchOptions): () => void {
  const routes = buildRoutePrefetchPlan(pathname, role);
  if (routes.length === 0 || typeof window === "undefined") return () => {};

  let cancelled = false;
  let cancelScheduled = () => {};
  let index = 0;

  const step = () => {
    if (cancelled || index >= routes.length) return;
    if (document.visibilityState !== "visible") {
      document.addEventListener("visibilitychange", startWhenVisible);
      return;
    }
    if (!runtimeAllowsPrefetch()) return;
    if (inputIsPending()) {
      cancelScheduled = whenIdle(step);
      return;
    }
    const route = routes[index++];
    void prefetchRoute(route).finally(() => {
      if (!cancelled) cancelScheduled = whenIdle(step);
    });
  };

  const startWhenVisible = () => {
    if (document.visibilityState !== "visible" || cancelled) return;
    document.removeEventListener("visibilitychange", startWhenVisible);
    cancelScheduled = whenIdle(step);
  };

  if (document.visibilityState === "visible") cancelScheduled = whenIdle(step);
  else document.addEventListener("visibilitychange", startWhenVisible);

  return () => {
    cancelled = true;
    cancelScheduled();
    document.removeEventListener("visibilitychange", startWhenVisible);
  };
}
