// ---------------------------------------------------------------------------
// <RequirePermission> — route-level (resource, action) gate (P3.6).
//
// Wrap any element that should only render when the current user holds the
// named permission. On a miss we redirect (default /dashboard) so the user
// lands somewhere they can use, instead of staring at a half-rendered shell
// while the API 403s every fetch.
//
//   <RequirePermission resource="accounting" action="read">
//     <AccountingPage />
//   </RequirePermission>
//
// Loading: while the permission set is still being fetched on first paint we
// render `null` (avoids a flash of redirect or fallback). The permission set
// is stale-while-revalidate cached, so this only happens on first session
// visit — every navigation after that is synchronous.
// ---------------------------------------------------------------------------
import { Navigate, useLocation } from "react-router-dom";
import { usePermissions } from "@/lib/use-permission";

type Props = {
  resource: string;
  action: string;
  /** Where to send users without permission. Defaults to /dashboard. */
  redirectTo?: string;
  /** If set, render this instead of redirecting on a miss. */
  fallback?: React.ReactNode;
  children: React.ReactNode;
};

export default function RequirePermission({
  resource,
  action,
  redirectTo = "/dashboard",
  fallback,
  children,
}: Props) {
  const { hasPermission, loading } = usePermissions();
  const location = useLocation();

  // First-load — no cached set yet. Render nothing rather than briefly
  // bouncing the user to /dashboard while the fetch is in flight.
  if (loading) return null;

  if (!hasPermission(resource, action)) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <Navigate
        to={redirectTo}
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  return <>{children}</>;
}
