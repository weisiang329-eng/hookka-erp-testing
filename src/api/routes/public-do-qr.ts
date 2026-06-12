// ---------------------------------------------------------------------------
// public-do-qr.ts — PUBLIC (no-login) QR dispatch/deliver flow for Delivery
// Orders and Packing Lists.
//
// A driver scans the QR printed on a DO or PL with a normal phone camera.
// The QR encodes /d/<token>; that page calls:
//
//   GET  /api/public/do-qr/:token          → minimal document summary
//   POST /api/public/do-qr/:token/advance  → { action: "DISPATCH"|"DELIVER" }
//
// Security model (the token IS the credential):
//   • qrtoken is 64 random hex chars (two UUIDs, migration 0167), minted
//     lazily by the AUTHED /:id/qr-token endpoints only — this route never
//     creates tokens.
//   • Forward-only: DISPATCH moves DRAFT → LOADED, DELIVER moves
//     LOADED/IN_TRANSIT → DELIVERED. Nothing else. No reversals, no edits.
//   • Idempotent: re-scanning after the step is done reports "already
//     dispatched/delivered" per DO instead of erroring.
//   • Minimal exposure: doNo, customer name, delivery area/state, item
//     count + first few product names, status. NO prices, NO addresses
//     beyond the area, NO contact details.
//   • Auth bypass is via PUBLIC_PREFIXES ("/api/public/do-qr/") in
//     lib/auth-middleware.ts; the shared apiRateLimit middleware still
//     applies (keyed by client IP) with a tightened override in
//     lib/api-rate-limit-config.ts.
//
// Cascade reuse (career-critical): the transition is performed by
// applyDeliveryOrderUpdate — the EXACT function behind the office
// PUT /api/delivery-orders/:id — so fg_units stamping, STOCK_OUT movements,
// SO status cascade, FIFO COGS, the auto-DRAFT invoice (+ collision retry)
// and the audit emit all fire identically to an office click. After a
// successful transition the SAME customer notice the office fires is queued
// via queueDoCustomerNotice (dispatch notice / invoice notice with the
// server-rendered PDF fallback). NOTHING is reimplemented here.
//
// Scanning a PL transitions ALL its member DOs together (sequentially, one
// at a time — same rule as the office bulk buttons: parallel DELIVERED
// batches deadlock on shared SO rows and collide on invoice numbers).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { ensureQrTokenColumns } from "../lib/do-qr-token";
import {
  applyDeliveryOrderUpdate,
  queueDoCustomerNotice,
} from "./delivery-orders";

const app = new Hono<Env>();

// Tokens are 64 hex chars. Reject anything else before touching the DB —
// fast 404 for junk paths and no way to probe with empty/odd values.
const TOKEN_RE = /^[0-9a-f]{64}$/i;

const unknownToken = (c: Context<Env>) =>
  c.json(
    {
      success: false,
      error:
        "Unknown or expired QR code. Please ask the Hookka office for a freshly printed copy.",
    },
    404,
  );

type PublicDoRow = {
  id: string;
  doNo: string;
  customerName: string | null;
  customerState: string | null;
  hubName: string | null;
  status: string;
  totalItems: number | null;
  orgId: string | null;
};

// Minimal per-DO summary — the ONLY fields the public page ever sees.
type PublicDoSummary = {
  id: string;
  doNo: string;
  customerName: string;
  area: string;
  status: string;
  itemCount: number;
  productNames: string[];
};

const DO_SUMMARY_COLS =
  "id, doNo, customerName, customerState, hubName, status, totalItems, orgId";

async function summarizeDos(
  db: D1Database,
  rows: PublicDoRow[],
): Promise<PublicDoSummary[]> {
  if (rows.length === 0) return [];
  const ph = rows.map(() => "?").join(",");
  const itemsRes = await db
    .prepare(
      `SELECT deliveryOrderId, productName, quantity
         FROM delivery_order_items WHERE deliveryOrderId IN (${ph})`,
    )
    .bind(...rows.map((r) => r.id))
    .all<{
      deliveryOrderId: string;
      productName: string | null;
      quantity: number | null;
    }>();
  const byDo = new Map<string, { names: string[]; count: number }>();
  for (const it of itemsRes.results ?? []) {
    const slot = byDo.get(it.deliveryOrderId) ?? { names: [], count: 0 };
    slot.count += Number(it.quantity) || 0;
    const name = (it.productName || "").trim();
    if (name && slot.names.length < 3 && !slot.names.includes(name)) {
      slot.names.push(name);
    }
    byDo.set(it.deliveryOrderId, slot);
  }
  return rows.map((r) => {
    const slot = byDo.get(r.id);
    return {
      id: r.id,
      doNo: r.doNo,
      customerName: r.customerName ?? "",
      area: (r.customerState || "").trim() || (r.hubName || "").trim() || "",
      status: r.status,
      itemCount: slot?.count || Number(r.totalItems) || 0,
      productNames: slot?.names ?? [],
    };
  });
}

// Resolve a token against BOTH tables. DOs first (the more common scan),
// then packing lists; the PL branch also loads its member DOs in the
// operator's stored selection order.
async function resolveToken(
  db: D1Database,
  token: string,
): Promise<
  | { kind: "DO"; dos: PublicDoRow[]; pl: null }
  | {
      kind: "PL";
      dos: PublicDoRow[];
      pl: { id: string; packingNo: string; orgId: string | null };
    }
  | null
> {
  await ensureQrTokenColumns(db);
  const doRow = await db
    .prepare(`SELECT ${DO_SUMMARY_COLS} FROM delivery_orders WHERE qrtoken = ?`)
    .bind(token)
    .first<PublicDoRow>();
  if (doRow) return { kind: "DO", dos: [doRow], pl: null };

  let plRow: {
    id: string;
    packingNo: string;
    doIds: string;
    orgId: string | null;
  } | null = null;
  try {
    plRow = await db
      .prepare(
        "SELECT id, packing_no, do_ids, org_id FROM packing_lists WHERE qrtoken = ?",
      )
      .bind(token)
      .first<{
        id: string;
        packingNo: string;
        doIds: string;
        orgId: string | null;
      }>();
  } catch {
    // packing_lists table not migrated yet — treat as no match.
  }
  if (!plRow) return null;

  let doIds: string[] = [];
  try {
    const v = JSON.parse(plRow.doIds || "[]");
    doIds = Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    doIds = [];
  }
  let dos: PublicDoRow[] = [];
  if (doIds.length > 0) {
    const ph = doIds.map(() => "?").join(",");
    const res = await db
      .prepare(
        `SELECT ${DO_SUMMARY_COLS} FROM delivery_orders WHERE id IN (${ph})`,
      )
      .bind(...doIds)
      .all<PublicDoRow>();
    const order = new Map(doIds.map((d, i) => [d, i]));
    dos = (res.results ?? []).sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
  }
  return {
    kind: "PL",
    dos,
    pl: { id: plRow.id, packingNo: plRow.packingNo, orgId: plRow.orgId },
  };
}

// Shared payload builder so GET and POST return the same summary shape.
async function buildSummaryPayload(
  db: D1Database,
  resolved: NonNullable<Awaited<ReturnType<typeof resolveToken>>>,
) {
  const dos = await summarizeDos(db, resolved.dos);
  if (resolved.kind === "DO") {
    return { kind: "DO" as const, dos };
  }
  return {
    kind: "PL" as const,
    packingNo: resolved.pl.packingNo,
    plId: resolved.pl.id,
    dos,
  };
}

// GET /api/public/do-qr/:token — document summary for the scan page.
app.get("/:token", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!TOKEN_RE.test(token)) return unknownToken(c);
  try {
    const resolved = await resolveToken(c.var.DB, token);
    if (!resolved) return unknownToken(c);
    const data = await buildSummaryPayload(c.var.DB, resolved);
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[GET /api/public/do-qr/:token] failed:", err);
    return c.json(
      { success: false, error: "Could not load this document. Please try again." },
      500,
    );
  }
});

// Forward-only step table. DISPATCH = the office "Mark Dispatched" button
// (DRAFT → LOADED); DELIVER = the office "Mark Delivered" button
// (LOADED / IN_TRANSIT → DELIVERED). Statuses already past the step are
// idempotent skips; anything else (DRAFT on DELIVER, CANCELLED) is blocked.
const STEP: Record<
  "DISPATCH" | "DELIVER",
  { from: string[]; to: "LOADED" | "DELIVERED"; past: string[]; kind: "DISPATCHED" | "DELIVERED" }
> = {
  DISPATCH: {
    from: ["DRAFT"],
    to: "LOADED",
    past: ["LOADED", "IN_TRANSIT", "DELIVERED", "INVOICED"],
    kind: "DISPATCHED",
  },
  DELIVER: {
    from: ["LOADED", "IN_TRANSIT"],
    to: "DELIVERED",
    past: ["DELIVERED", "INVOICED"],
    kind: "DELIVERED",
  },
};

type AdvanceResult = {
  doNo: string;
  outcome: "DONE" | "SKIPPED" | "BLOCKED" | "FAILED";
  from: string;
  to?: string;
  note?: string;
};

// POST /api/public/do-qr/:token/advance — perform the one forward step.
app.post("/:token/advance", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!TOKEN_RE.test(token)) return unknownToken(c);

  const body = (await c.req.json().catch(() => ({}))) as { action?: string };
  const action =
    body.action === "DISPATCH" || body.action === "DELIVER"
      ? body.action
      : null;
  if (!action) {
    return c.json(
      { success: false, error: 'action must be "DISPATCH" or "DELIVER"' },
      400,
    );
  }

  try {
    const resolved = await resolveToken(c.var.DB, token);
    if (!resolved) return unknownToken(c);
    if (resolved.dos.length === 0) {
      return c.json(
        { success: false, error: "This packing list has no delivery orders." },
        409,
      );
    }

    const step = STEP[action];
    const results: AdvanceResult[] = [];
    for (const d of resolved.dos) {
      const from = (d.status || "").toUpperCase();
      if (step.past.includes(from)) {
        results.push({
          doNo: d.doNo,
          outcome: "SKIPPED",
          from,
          note:
            action === "DISPATCH" ? "Already dispatched" : "Already delivered",
        });
        continue;
      }
      if (!step.from.includes(from)) {
        results.push({
          doNo: d.doNo,
          outcome: "BLOCKED",
          from,
          note:
            action === "DELIVER" && from === "DRAFT"
              ? "Not dispatched yet"
              : `Cannot ${action === "DISPATCH" ? "dispatch" : "deliver"} from ${from}`,
        });
        continue;
      }

      // The DELIVERED cascade reads getOrgId(c) for the invoice ledger
      // legs. There is no session on this route, so stash the DO row's own
      // orgId (the token resolved to this exact row — no cross-tenant
      // reach). Same context-stash cast tenantMiddleware uses.
      const orgId = d.orgId || resolved.pl?.orgId || null;
      if (!orgId) {
        results.push({
          doNo: d.doNo,
          outcome: "FAILED",
          from,
          note: "Document has no organisation",
        });
        continue;
      }
      (c as unknown as { set: (k: string, v: unknown) => void }).set(
        "orgId",
        orgId,
      );

      // THE office transition path — identical guards + cascades.
      const res = await applyDeliveryOrderUpdate(c, d.id, {
        status: step.to,
      });
      let ok = false;
      let errMsg = "";
      try {
        const j = (await res.json()) as { success?: boolean; error?: string };
        ok = res.ok && !!j?.success;
        errMsg = j?.error || "";
      } catch {
        ok = res.ok;
      }
      if (!ok) {
        results.push({
          doNo: d.doNo,
          outcome: "FAILED",
          from,
          note: errMsg || `HTTP ${res.status}`,
        });
        continue;
      }
      results.push({ doNo: d.doNo, outcome: "DONE", from, to: step.to });

      // Queue the SAME customer notice the office click queues (dispatch
      // notice / invoice notice). Best-effort — the transition is already
      // committed; a notice hiccup must not fail the scan. The endpoint is
      // idempotent (dispatchEmailAt / deliveredEmailAt claims), so an
      // office re-click later cannot double-send.
      try {
        const noticeRes = await queueDoCustomerNotice(c, d.id, {
          kind: step.kind,
        });
        // Consume the body so the Response doesn't leak.
        await noticeRes.json().catch(() => undefined);
      } catch (noticeErr) {
        console.warn(
          `[public-do-qr] ${d.doNo}: customer notice after ${action} failed:`,
          noticeErr instanceof Error ? noticeErr.message : noticeErr,
        );
      }
    }

    // Fresh summary so the page can re-render the new statuses without a
    // second round-trip.
    const after = await resolveToken(c.var.DB, token);
    const summary = after
      ? await buildSummaryPayload(c.var.DB, after)
      : undefined;

    const tally = {
      done: results.filter((r) => r.outcome === "DONE").length,
      skipped: results.filter((r) => r.outcome === "SKIPPED").length,
      blocked: results.filter((r) => r.outcome === "BLOCKED").length,
      failed: results.filter((r) => r.outcome === "FAILED").length,
    };
    return c.json({ success: true, data: { action, results, ...tally, summary } });
  } catch (err) {
    console.error("[POST /api/public/do-qr/:token/advance] failed:", err);
    return c.json(
      {
        success: false,
        error: "Could not update this delivery. Please try again or contact the Hookka office.",
      },
      500,
    );
  }
});

export default app;
