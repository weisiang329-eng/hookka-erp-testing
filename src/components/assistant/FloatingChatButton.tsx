// ---------------------------------------------------------------------------
// Floating action button that opens Hookka AI.
//
// Behaviour:
//   - Only renders for SUPER_ADMIN users (mirrors the route gate).
//   - Hidden when already on /assistant (no point linking to itself).
//   - Bottom-right fixed position, above page content but below modal
//     overlays (z-30; modals in the app use z-50+).
//   - Click navigates to /assistant — v1 is full-page, no slide-over.
// ---------------------------------------------------------------------------

import { useNavigate, useLocation } from "react-router-dom";
import { getCurrentUser } from "@/lib/auth";
import { HookkaAILogo } from "./HookkaAILogo";

export function FloatingChatButton() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const user = getCurrentUser();
  if (!user || user.role !== "SUPER_ADMIN") return null;
  if (pathname.startsWith("/assistant")) return null;

  return (
    <button
      type="button"
      onClick={() => navigate("/assistant")}
      aria-label="Open Hookka AI"
      title="Hookka AI"
      className="fixed bottom-6 right-6 z-30 h-14 w-14 rounded-full bg-[#1F1D1B] text-white shadow-lg hover:bg-[#3a3633] focus:outline-none focus:ring-2 focus:ring-[#6B5C32] transition-colors flex items-center justify-center"
    >
      <HookkaAILogo size={28} />
    </button>
  );
}

export default FloatingChatButton;
