// Shared constants/helpers for the dashboard-prototype tabs — split out of
// dashboard-shared.tsx because a file mixing component exports with
// constant/function exports breaks Vite Fast Refresh (react-refresh/only-
// export-components).
export const TAUPE = "#6B5C32";
export const TEAL = "#3E6570";
export const MUTED = "#6B7280";
export const BORDER = "#E2DDD8";
export const GREEN = "#4F7C3A";
export const AMBER = "#9C6F1E";
export const RED = "#9A3A2D";

export function fmtN(n: number): string {
  return n.toLocaleString("en-MY");
}
