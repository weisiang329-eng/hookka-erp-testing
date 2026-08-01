// ---------------------------------------------------------------------------
// party-alias-client.ts — FE half of the scanners' memory.
//
// Owner 2026-08-01: 「无论什么情况我们改对了 OCR 就应该学习…都教导他了啊」.
//
// The party matchers run client-side inside the scan modals, so each modal
// loads the whole alias map once (one small GET, same shape as the catalog it
// already fetches) and resolves locally. Teaching happens the moment a document
// is created under an operator-approved party — that is the strongest signal
// available and, unlike the scan-sample confirm path, it is actually reached by
// the queue-based wizards.
//
// Shared by all four OCR surfaces: customer PO → SO/CO, Purchase Invoice, GRN,
// and the finance bill / voucher prefill.
//
// Both calls are best-effort: a scan must never fail because the memory is
// unavailable. A miss simply falls back to the string heuristics.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { normalizeCompanyName } from "./company-name-match";

export type PartyType = "CUSTOMER" | "SUPPLIER" | "OTHER_PARTY";

/** normalised OCR name → partyId */
export type AliasMap = Record<string, string>;

/** Same key the server stores under — legal suffix + punctuation stripped. */
export function aliasKey(rawName: string | null | undefined): string {
  return normalizeCompanyName(rawName);
}

/** Resolve a scanned name against an already-loaded map. */
export function resolveAlias(
  aliasMap: AliasMap | null | undefined,
  rawName: string | null | undefined,
): string | null {
  if (!aliasMap) return null;
  const key = aliasKey(rawName);
  if (!key) return null;
  return aliasMap[key] ?? null;
}

export async function fetchPartyAliases(type: PartyType): Promise<AliasMap> {
  try {
    const res = await fetch(`/api/party-aliases?type=${type}`, {
      credentials: "include",
    });
    if (!res.ok) return {};
    const j = (await res.json()) as { data?: { aliases?: AliasMap } };
    return j.data?.aliases ?? {};
  } catch {
    return {};
  }
}

/**
 * Remember that `rawName` (as OCR read it) means `partyId`.
 *
 * Fire-and-forget from a create loop — a failure here must never surface as a
 * document-creation error. Skips the call when OCR read nothing useful, or when
 * the name already resolves to this same party (nothing new to learn).
 */
export async function teachPartyAlias(opts: {
  partyType: PartyType;
  partyId: string;
  rawName: string | null | undefined;
  knownMap?: AliasMap | null;
}): Promise<void> {
  const key = aliasKey(opts.rawName);
  if (!key || !opts.partyId) return;
  if (opts.knownMap && opts.knownMap[key] === opts.partyId) return;
  try {
    await fetch("/api/party-aliases", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        partyType: opts.partyType,
        partyId: opts.partyId,
        rawName: opts.rawName,
      }),
    });
  } catch {
    /* best-effort — never block the document that was just created */
  }
}

/**
 * Load the alias map for a party type while `active` is true (i.e. the modal is
 * open). Re-fetches on open so an alias taught in a previous session — or by a
 * colleague — is picked up without a page reload.
 */
export function usePartyAliases(type: PartyType, active: boolean): AliasMap {
  const [map, setMap] = useState<AliasMap>({});
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetchPartyAliases(type).then((m) => {
      if (!cancelled) setMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, [type, active]);
  return map;
}
