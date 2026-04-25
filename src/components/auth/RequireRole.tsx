// ---------------------------------------------------------------------------
// <RequireRole> — coarser-grained role gate (P3.6).
//
// Use this for screens scoped to a single role rather than a (resource,
// action) tuple — e.g. SUPER_ADMIN-only settings. Reads the role string
// straight off the auth blob (getCurrentUser().role) so it doesn't have to
// wait for /api/auth/me/permissions to resolve.
//
//   <RequireRole role="SUPER_ADMIN">
//     <UserManagementPage />
//   </RequireRole>
// ---------------------------------------------------------------------------
import { Navigate, useLocation } from "react-router-dom";
import { getCurrentUser } from "@/lib/auth";

type Props = {
  /** e.g. "SUPER_ADMIN", "FINANCE". Matched against users.role exactly. */
  role: string;
  /** Where to send users without the role. Defaults to /dashboard. */
  redirectTo?: string;
  /** If set, render this instead of redirecting on a miss. */
  fallback?: React.ReactNode;
  children: React.ReactNode;
};

export default function RequireRole({
  role,
  redirectTo = "/dashboard",
  fallback,
  children,
}: Props) {
  const user = getCurrentUser();
  const location = useLocation();

  if (!user || user.role !== role) {
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
