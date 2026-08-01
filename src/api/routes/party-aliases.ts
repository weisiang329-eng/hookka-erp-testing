// ---------------------------------------------------------------------------
// /api/party-aliases — the scanners' memory of who a document belongs to.
//
// Owner 2026-08-01: 「都教导他了啊」. The matchers run client-side in the scan
// modals, so the FE fetches the whole alias map alongside the catalog (one
// small round trip, same as suppliers / customers) and resolves locally before
// falling back to heuristics. Recording happens the moment a document is
// created under an operator-approved party — the strongest possible signal,
// and it does not depend on the broken scan-sample confirm path.
//
//   GET  /api/party-aliases?type=SUPPLIER   → { aliases: { <normName>: partyId } }
//   POST /api/party-aliases                 → teach one alias
//        body { partyType, partyId, rawName }
//   GET  /api/party-aliases/list?type=…     → rows, for a maintenance screen
//   DELETE /api/party-aliases               → forget one
//        body { partyType, aliasNorm }
//
// Permissions ride on the party being taught: SUPPLIER → suppliers, CUSTOMER →
// customers, OTHER_PARTY → accounting. Reading is gated on the same resource's
// read action so a scan operator who can create the document can also read the
// map they are about to extend.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  ensurePartyAliasTable,
  isPartyType,
  loadPartyAliasMap,
  recordPartyAlias,
  aliasKey,
  type PartyType,
} from "../lib/party-alias";

const app = new Hono<Env>();

const RESOURCE: Record<PartyType, string> = {
  SUPPLIER: "suppliers",
  CUSTOMER: "customers",
  OTHER_PARTY: "accounting",
};

function readType(c: { req: { query: (k: string) => string | undefined } }): PartyType | null {
  const t = (c.req.query("type") ?? "").toUpperCase();
  return isPartyType(t) ? t : null;
}

// GET /api/party-aliases?type=SUPPLIER
app.get("/", async (c) => {
  const partyType = readType(c);
  if (!partyType) {
    return c.json(
      { success: false, error: "type must be CUSTOMER, SUPPLIER or OTHER_PARTY" },
      400,
    );
  }
  const denied = await requirePermission(c, RESOURCE[partyType], "read");
  if (denied) return denied;
  const aliases = await loadPartyAliasMap(
    c.var.DB as unknown as Parameters<typeof loadPartyAliasMap>[0],
    getOrgId(c),
    partyType,
  );
  return c.json({ success: true, data: { partyType, aliases } });
});

// GET /api/party-aliases/list?type=SUPPLIER — full rows for a maintenance view.
app.get("/list", async (c) => {
  const partyType = readType(c);
  if (!partyType) {
    return c.json({ success: false, error: "type is required" }, 400);
  }
  const denied = await requirePermission(c, RESOURCE[partyType], "read");
  if (denied) return denied;
  await ensurePartyAliasTable(
    c.var.DB as unknown as Parameters<typeof ensurePartyAliasTable>[0],
  );
  const res = await c.var.DB.prepare(
    `SELECT alias_norm AS "aliasNorm", alias_raw AS "aliasRaw",
            party_id AS "partyId", hits, created_by AS "createdBy",
            created_at AS "createdAt", last_used_at AS "lastUsedAt"
       FROM party_name_aliases
      WHERE party_type = ? AND (org_id = ? OR org_id IS NULL)
      ORDER BY hits DESC, alias_raw`,
  )
    .bind(partyType, getOrgId(c))
    .all();
  return c.json({ success: true, data: { partyType, rows: res.results ?? [] } });
});

// POST /api/party-aliases — teach one alias.
app.post("/", async (c) => {
  let body: { partyType?: unknown; partyId?: unknown; rawName?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body." }, 400);
  }
  const partyType = String(body.partyType ?? "").toUpperCase();
  if (!isPartyType(partyType)) {
    return c.json(
      { success: false, error: "partyType must be CUSTOMER, SUPPLIER or OTHER_PARTY" },
      400,
    );
  }
  // Teaching an alias steers future documents to a party — gate it on the
  // party's UPDATE action, not merely read.
  const denied = await requirePermission(c, RESOURCE[partyType], "update");
  if (denied) return denied;

  const partyId = String(body.partyId ?? "").trim();
  const rawName = typeof body.rawName === "string" ? body.rawName : "";
  if (!partyId || !aliasKey(rawName)) {
    return c.json(
      { success: false, error: "partyId and a rawName with letters are required" },
      400,
    );
  }
  const r = await recordPartyAlias(
    c.var.DB as unknown as Parameters<typeof recordPartyAlias>[0],
    {
      orgId: getOrgId(c),
      partyType,
      partyId,
      rawName,
      createdBy: (c.get("userId" as never) as string | undefined) ?? null,
    },
  );
  return c.json({ success: r.recorded, data: r }, r.recorded ? 200 : 400);
});

// DELETE /api/party-aliases — forget a mis-taught alias.
app.delete("/", async (c) => {
  let body: { partyType?: unknown; aliasNorm?: unknown; rawName?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body." }, 400);
  }
  const partyType = String(body.partyType ?? "").toUpperCase();
  if (!isPartyType(partyType)) {
    return c.json({ success: false, error: "partyType is required" }, 400);
  }
  const denied = await requirePermission(c, RESOURCE[partyType], "update");
  if (denied) return denied;
  // Accept either the normalised key or the raw name the operator sees.
  const norm =
    typeof body.aliasNorm === "string" && body.aliasNorm.trim()
      ? body.aliasNorm.trim()
      : aliasKey(typeof body.rawName === "string" ? body.rawName : "");
  if (!norm) {
    return c.json({ success: false, error: "aliasNorm or rawName is required" }, 400);
  }
  await ensurePartyAliasTable(
    c.var.DB as unknown as Parameters<typeof ensurePartyAliasTable>[0],
  );
  await c.var.DB.prepare(
    `DELETE FROM party_name_aliases
      WHERE party_type = ? AND alias_norm = ? AND (org_id = ? OR org_id IS NULL)`,
  )
    .bind(partyType, norm, getOrgId(c))
    .run();
  return c.json({ success: true, data: { partyType, aliasNorm: norm } });
});

export default app;
