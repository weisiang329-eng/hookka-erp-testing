// ---------------------------------------------------------------------------
// Mail Center — pick the DEFAULT "From" mailbox for the logged-in user.
//
// Both the New-email composer (compose.tsx) and the Reply box (detail.tsx) used
// to default the From to a FIXED address (the first active mailbox / the
// thread's mailbox). Owner ask (2026-06-23): default the From to the mailbox
// that belongs to the CURRENT logged-in user, while keeping the dropdown
// switchable.
//
// This is a PURE helper (no React, no network) so it's shared by both surfaces
// and unit-testable. The caller passes the active mailbox list + the current
// user's identity; we return the address string to default to, or "" when the
// user maps to NO available mailbox — in which case the caller MUST fall back to
// its existing default (never blank the form).
//
// Matching, strongest signal first:
//   1. address.assignedUserId === user.id   (the canonical "this mailbox is
//      assigned to this person" link from email_addresses.assigned_user_id).
//   2. address.address === user.email        (case-insensitive) — the user logs
//      in with their own @hookka.com address.
//   3. local-part match: the part before "@" of address.address equals the
//      local-part of user.email (case-insensitive) — e.g. user lim@hookka.com
//      (or lim@anything) → lim@hookka.com. Covers a login email on a different
//      domain than the mailbox.
// First match in list order wins within a tier.
// ---------------------------------------------------------------------------

// Only the fields we actually read — the real MailAddress carries more.
export type FromDefaultAddress = {
  address: string;
  assignedUserId?: string | null;
};

export type FromDefaultUser = {
  id?: string | null;
  email?: string | null;
};

// Local-part (before the first "@"), lowercased. "" when there's no "@".
function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at).toLowerCase() : "";
}

// Returns the address to DEFAULT the From to for `user`, or "" when the user
// maps to no address in `addresses` (caller keeps its existing default).
export function pickDefaultFromAddress(
  addresses: FromDefaultAddress[] | undefined,
  user: FromDefaultUser | null | undefined,
): string {
  const list = addresses ?? [];
  if (list.length === 0) return "";

  const userId = (user?.id ?? "").trim();
  const userEmail = (user?.email ?? "").trim().toLowerCase();
  const userLocal = localPart(userEmail);

  // 1. Assigned-to-user link (strongest).
  if (userId) {
    const byAssignment = list.find(
      (a) => (a.assignedUserId ?? "") === userId,
    );
    if (byAssignment?.address) return byAssignment.address;
  }

  if (!userEmail) return "";

  // 2. Exact address == login email.
  const byEmail = list.find(
    (a) => (a.address ?? "").toLowerCase() === userEmail,
  );
  if (byEmail?.address) return byEmail.address;

  // 3. Local-part match (login email domain may differ from the mailbox domain).
  if (userLocal) {
    const byLocal = list.find(
      (a) => localPart((a.address ?? "").toLowerCase()) === userLocal,
    );
    if (byLocal?.address) return byLocal.address;
  }

  return "";
}
