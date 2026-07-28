// ---------------------------------------------------------------------------
// Floating action button that opens the Hookka AI slide-over panel.
//
// Behaviour:
//   - Only renders for SUPER_ADMIN users (mirrors the API gate on
//     /api/assistant/chat).
//   - Bottom-right fixed position, above page content but below modals
//     (z-40 for the button; the panel itself sits at z-50).
//   - Click toggles the slide-over open/closed. While open the button
//     swaps its icon to an X (standard Intercom / Drift pattern) so the
//     same hit-target is also the "close" affordance — feels less janky
//     than hiding the button on open.
//   - Escape inside the panel also closes it (handled in the slide-over).
// ---------------------------------------------------------------------------

import { useState } from "react";
import { X } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { HookkaAILogo } from "./HookkaAILogo";
import { AssistantSlideOver } from "./AssistantSlideOver";

export function FloatingChatButton() {
  const user = getCurrentUser();
  const [open, setOpen] = useState(false);

  // Open to any logged-in staff (owner 2026-07-28 "开放命令/教 agent 给全部员工").
  // Non-super-admins get a restricted chat — only the agent command/teach tools;
  // data / SQL / financial tools stay owner-only, enforced server-side in
  // /api/assistant/chat (schema filter + dispatch guard). This UI gate only
  // hides the button from logged-out users.
  if (!user) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close Hookka AI" : "Open Hookka AI"}
        aria-expanded={open}
        title={open ? "Close Hookka AI" : "Hookka AI"}
        className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full bg-[#1F1D1B] text-white shadow-lg hover:bg-[#3a3633] focus:outline-none focus:ring-2 focus:ring-[#6B5C32] transition-colors flex items-center justify-center"
      >
        {open ? <X className="h-6 w-6" /> : <HookkaAILogo size={28} />}
      </button>
      <AssistantSlideOver open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export default FloatingChatButton;
