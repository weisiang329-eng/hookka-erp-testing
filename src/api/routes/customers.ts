// ---------------------------------------------------------------------------
// D1-backed customers route.
//
// Mirrors the old src/api/routes/customers.ts shape so the SPA frontend
// doesn't need any changes. `deliveryHubs` is returned as a nested array
// joined from the delivery_hubs table (matches the in-memory Customer type).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { checkCustomerDeleteLocked, lockedResponse } from "../lib/lock-helpers";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

type CustomerRow = {
  id: string;
  code: string;
  name: string;
  ssmNo: string | null;
  companyAddress: string | null;
  creditTerms: string | null;
  creditLimitSen: number;
  outstandingSen: number;
  isActive: number;
  contactName: string | null;
  phone: string | null;
  email: string | null;
};

type HubRow = {
  id: string;
  customerId: string;
  code: string;
  shortName: string;
  state: string | null;
  address: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  isDefault: number;
};

function rowToCustomer(row: CustomerRow, hubs: HubRow[] = []) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    ssmNo: row.ssmNo ?? "",
    companyAddress: row.companyAddress ?? "",
    creditTerms: row.creditTerms ?? "NET30",
    creditLimitSen: row.creditLimitSen,
    outstandingSen: row.outstandingSen,
    isActive: Boolean(row.isActive),
    contactName: row.contactName ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    deliveryHubs: hubs
      .filter((h) => h.customerId === row.id)
      .map((h) => ({
        id: h.id,
        code: h.code,
        shortName: h.shortName,
        state: h.state ?? "",
        address: h.address ?? "",
        contactName: h.contactName ?? "",
        phone: h.phone ?? "",
        email: h.email ?? "",
        isDefault: Boolean(h.isDefault),
      })),
  };
}

function genId(): string {
  return `cust-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/customers — list all customers + their hubs (org-scoped)
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const [customers, hubs] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM customers WHERE orgId = ? ORDER BY code")
      .bind(orgId)
      .all<CustomerRow>(),
    c.var.DB.prepare("SELECT * FROM delivery_hubs WHERE orgId = ?")
      .bind(orgId)
      .all<HubRow>(),
  ]);
  const data = (customers.results ?? []).map((r) =>
    rowToCustomer(r, hubs.results ?? []),
  );
  return c.json({ success: true, data });
});

// POST /api/customers — create
app.post("/", async (c) => {
  const denied = await requirePermission(c, "customers", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { code, name } = body;
    if (!code || !name) {
      return c.json(
        { success: false, error: "code and name are required" },
        400,
      );
    }
    const id = genId();
    const isActive = body.isActive === false ? 0 : 1;

    // Tier D D5 fix 2026-05-21 — back-door write removed.
    // outstandingSen is a derived A/R balance owned by the invoice +
    // payment + CN/DN ledger. The customers create form has no input
    // cell for it; accepting `body.outstandingSen` here let admin
    // scripts (and any caller hand-crafting a POST) seed an arbitrary
    // opening balance that has no supporting invoice row, so the next
    // payment posting would either over- or under-decrement against
    // ghost A/R. Force to 0 at creation; the value will move only
    // through the invoice / payment / CN / DN routes' atomic SQL.
    await c.var.DB.prepare(
      `INSERT INTO customers (id, code, name, ssmNo, companyAddress, creditTerms,
         creditLimitSen, outstandingSen, isActive, contactName, phone, email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        body.code,
        body.name,
        body.ssmNo ?? "",
        body.companyAddress ?? "",
        body.creditTerms ?? "NET30",
        body.creditLimitSen ?? 0,
        0,
        isActive,
        body.contactName ?? "",
        body.phone ?? "",
        body.email ?? "",
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM customers WHERE id = ?",
    )
      .bind(id)
      .first<CustomerRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create customer" },
        500,
      );
    }
    return c.json({ success: true, data: rowToCustomer(created, []) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/customers/:id — single customer + hubs
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [cust, hubsRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM customers WHERE id = ?")
      .bind(id)
      .first<CustomerRow>(),
    c.var.DB.prepare("SELECT * FROM delivery_hubs WHERE customerId = ?")
      .bind(id)
      .all<HubRow>(),
  ]);
  if (!cust) {
    return c.json({ success: false, error: "Customer not found" }, 404);
  }
  return c.json({ success: true, data: rowToCustomer(cust, hubsRes.results ?? []) });
});

// PUT /api/customers/:id — update
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM customers WHERE id = ?",
    )
      .bind(id)
      .first<CustomerRow>();
    if (!existing) {
      return c.json({ success: false, error: "Customer not found" }, 404);
    }
    const body = await c.req.json();

    // Tier D D5 fix 2026-05-21 — back-door write removed.
    // outstandingSen is derived from the invoice + payment + CN/DN
    // ledger. The customer edit dialog has no input cell for it, so any
    // value arriving in `body.outstandingSen` came from a hand-crafted
    // PUT or stale admin script. Pinning to existing prevents a one-off
    // PUT from silently overwriting the ledger-derived balance with
    // whatever the caller felt like. The four legitimate writers
    // (invoices.ts AR add, payments.ts decrement on POST + GREATEST
    // rollback on BOUNCED, credit-notes.ts decrement, debit-notes.ts
    // increment) all use atomic `outstandingSen = outstandingSen +/- ?`
    // SQL and never touch this PUT route.
    const merged = {
      code: body.code ?? existing.code,
      name: body.name ?? existing.name,
      ssmNo: body.ssmNo ?? existing.ssmNo ?? "",
      companyAddress: body.companyAddress ?? existing.companyAddress ?? "",
      creditTerms: body.creditTerms ?? existing.creditTerms ?? "NET30",
      creditLimitSen: body.creditLimitSen ?? existing.creditLimitSen,
      outstandingSen: existing.outstandingSen,
      isActive:
        body.isActive === undefined
          ? existing.isActive
          : body.isActive
            ? 1
            : 0,
      contactName: body.contactName ?? existing.contactName ?? "",
      phone: body.phone ?? existing.phone ?? "",
      email: body.email ?? existing.email ?? "",
    };

    await c.var.DB.prepare(
      `UPDATE customers SET
         code = ?, name = ?, ssmNo = ?, companyAddress = ?, creditTerms = ?,
         creditLimitSen = ?, outstandingSen = ?, isActive = ?,
         contactName = ?, phone = ?, email = ?
       WHERE id = ?`,
    )
      .bind(
        merged.code,
        merged.name,
        merged.ssmNo,
        merged.companyAddress,
        merged.creditTerms,
        merged.creditLimitSen,
        merged.outstandingSen,
        merged.isActive,
        merged.contactName,
        merged.phone,
        merged.email,
        id,
      )
      .run();

    // ---- Sync delivery_hubs ----
    // Frontend sends the FULL hub array on every customer save (the customers
    // page mutates `customer.deliveryHubs` locally, then PUTs the whole
    // record). Diff strategy:
    //   - DELETE rows whose id isn't in the incoming array (preserves FK
    //     refs from sales_orders.hubId / delivery_orders.hubId /
    //     consignment_orders.hubId — those FKs are ON DELETE SET NULL,
    //     so dropping a hub orphans those refs).
    //   - UPSERT each incoming hub on its id (so existing hubs keep
    //     their id and SO/DO/CO refs stay valid).
    // This is the missing half of the save path — pre-fix the PUT only
    // updated the customers row, so hubs added in the UI evaporated on
    // page reload.
    if (Array.isArray(body.deliveryHubs)) {
      type IncomingHub = {
        id?: string;
        code?: string;
        shortName?: string;
        state?: string;
        address?: string;
        contactName?: string;
        phone?: string;
        email?: string;
        isDefault?: boolean;
      };
      const incoming = (body.deliveryHubs as IncomingHub[]).filter(
        (h) => typeof h?.id === "string" && h.id.length > 0,
      );
      const incomingIds = new Set(incoming.map((h) => h.id as string));

      const existingHubsRes = await c.var.DB.prepare(
        "SELECT id FROM delivery_hubs WHERE customerId = ?",
      )
        .bind(id)
        .all<{ id: string }>();
      const existingIds = (existingHubsRes.results ?? []).map((r) => r.id);

      for (const oldId of existingIds) {
        if (!incomingIds.has(oldId)) {
          await c.var.DB.prepare("DELETE FROM delivery_hubs WHERE id = ?")
            .bind(oldId)
            .run();
        }
      }

      for (const h of incoming) {
        await c.var.DB.prepare(
          `INSERT INTO delivery_hubs
             (id, customerId, code, shortName, state, address, contactName, phone, email, isDefault)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             code = excluded.code,
             shortName = excluded.shortName,
             state = excluded.state,
             address = excluded.address,
             contactName = excluded.contactName,
             phone = excluded.phone,
             email = excluded.email,
             isDefault = excluded.isDefault`,
        )
          .bind(
            h.id ?? "",
            id,
            h.code ?? "",
            h.shortName ?? "",
            h.state ?? null,
            h.address ?? null,
            h.contactName ?? null,
            h.phone ?? null,
            h.email ?? null,
            h.isDefault ? 1 : 0,
          )
          .run();
      }
    }

    const hubsRes = await c.var.DB.prepare(
      "SELECT * FROM delivery_hubs WHERE customerId = ?",
    )
      .bind(id)
      .all<HubRow>();
    return c.json({
      success: true,
      data: rowToCustomer({ ...existing, ...merged, id }, hubsRes.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/customers/:id — cascades via FK to delivery_hubs.
// Cascade-lock guard: blocks the delete if the customer is referenced by
// any non-cancelled SO/CO/DO/CN/Invoice. Returns 409 with a hint listing
// the blocking documents so the operator can clean those up first.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM customers WHERE id = ?",
  )
    .bind(id)
    .first<CustomerRow>();
  if (!existing) {
    return c.json({ success: false, error: "Customer not found" }, 404);
  }
  const lockMsg = await checkCustomerDeleteLocked(c.var.DB, id);
  if (lockMsg) {
    return c.json(lockedResponse(lockMsg), 409);
  }
  await c.var.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: rowToCustomer(existing, []) });
});

export default app;
