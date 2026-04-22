// ---------------------------------------------------------------------------
// RequireAuth — route guard used in src/router.tsx.
//
// Wraps children with an `isAuthenticated()` check. If the user isn't logged
// in we <Navigate> to /login and preserve the intended URL in location state
// so the Login page can redirect back after a successful sign-in.
// ---------------------------------------------------------------------------
import { Navigate, useLocation } from "react-router-dom";
import { isAuthenticated } from "@/lib/auth";

type Props = { children: React.ReactNode };

export default function RequireAuth({ children }: Props) {
  const location = useLocation();
  if (!isAuthenticated()) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return <>{children}</>;
}
