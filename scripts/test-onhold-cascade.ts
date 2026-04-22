// ============================================================================
// test-onhold-cascade.ts — SO ON_HOLD / RESUME smoke test.
//
// Exercises the full cascade end-to-end against a running API (REMOTE by
// default). Flow:
//   1. POST login → get auth cookie.
//   2. Pick any existing Customer + Product so we don't need to seed those.
//   3. POST /api/sales-orders → create a tiny DRAFT SO with one line item.
//   4. POST /api/sales-orders/:id/confirm → CONFIRMED + PO cascade fires.
//   5. Verify at least one production_order exists, remember its status.
//   6. PUT /api/sales-orders/:id { status: "ON_HOLD" } → cascade hold.
//   7. Assert every affected PO flipped to ON_HOLD and cascade.actions != [].
//   8. PUT /api/sales-orders/:id { status: "CONFIRMED" } → resume.
//   9. Assert every affected PO is back to PENDING.
//  10. Clean up: best-effort DELETE the created SO (stays CONFIRMED otherwise —
//      D1 FK cascade takes the items + POs along).
//
// Usage:
//   npx tsx scripts/test-onhold-cascade.ts              # REMOTE (default)
//   BASE_URL=http://localhost:8788 npx tsx scripts/test-onhold-cascade.ts
// ============================================================================

const BASE_URL = process.env.BASE_URL ?? "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.ADMIN_EMAIL ?? "weisiang329@gmail.com";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "CbpxqJQpjy3VA5yd3Q";

type AnyRec = Record<string, unknown>;

function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// Bearer token obtained from POST /api/auth/login. The API returns it in
// the response body (no HttpOnly cookie in this codebase).
let token = "";

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: AnyRec }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: AnyRec = {};
  try {
    data = text ? (JSON.parse(text) as AnyRec) : {};
  } catch {
    data = { _raw: text };
  }
  return { status: res.status, data };
}

async function login(): Promise<void> {
  const r = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  ok(r.status === 200 && r.data.success === true, `login (${r.status})`);
  const d = r.data.data as AnyRec | undefined;
  token = (d?.token as string) ?? "";
  ok(!!token, "auth token received");
}

async function pickFixtures(): Promise<{
  customerId: string;
  hubId: string | null;
  product: AnyRec;
}> {
  const cR = await call("GET", "/api/customers");
  const cs = (cR.data.data ?? []) as AnyRec[];
  ok(cs.length > 0, `customers endpoint returned ${cs.length} rows`);
  const customer = cs[0];
  const hubId = (customer.deliveryHubs as AnyRec[] | undefined)?.[0]?.id as
    | string
    | undefined;

  const pR = await call("GET", "/api/products");
  const ps = (pR.data.data ?? []) as AnyRec[];
  // Pick the first BEDFRAME product that has a sizeCode — the product list
  // in this codebase is flat (one row per size), not nested, so we just look
  // for a row with all the fields populated.
  const product =
    ps.find((p) => (p.category as string) === "BEDFRAME" && !!p.sizeCode) ||
    ps.find((p) => !!p.sizeCode) ||
    ps[0];
  ok(product !== undefined, `picked product ${product?.code ?? "?"}`);

  return {
    customerId: customer.id as string,
    hubId: hubId ?? null,
    product: product as AnyRec,
  };
}

async function main(): Promise<void> {
  console.log(`[1/10] login ${BASE_URL}`);
  await login();

  console.log(`[2/10] pick customer + product`);
  const { customerId, hubId, product } = await pickFixtures();
  const sizeCode = (product.sizeCode as string) || "Q";
  const sizeLabel = (product.sizeLabel as string) || "Queen";
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[3/10] create DRAFT SO`);
  const createBody: AnyRec = {
    customerId,
    hubId,
    customerPOId: `TEST-PO-${Date.now()}`,
    customerSOId: `TEST-SO-${Date.now()}`,
    reference: "onhold-cascade smoke test — safe to delete",
    companySODate: today,
    customerDeliveryDate: today,
    hookkaExpectedDD: today,
    notes: "Automated cascade test.",
    items: [
      {
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        itemCategory: (product.category as string) || "BEDFRAME",
        sizeCode,
        sizeLabel,
        fabricId: "",
        fabricCode: "",
        quantity: 1,
        basePriceSen: 100000,
        gapInches: 3,
        divanHeightInches: 8,
        divanPriceSen: 0,
        legHeightInches: 4,
        legPriceSen: 0,
        specialOrder: "",
        specialOrderPriceSen: 0,
        notes: "",
      },
    ],
  };
  const createR = await call("POST", "/api/sales-orders", createBody);
  ok(
    createR.status === 201 && createR.data.success === true,
    `SO created (${createR.status})`,
  );
  const createdSO = (createR.data.data as AnyRec) ?? {};
  const soId = createdSO.id as string;
  ok(!!soId, `SO id = ${soId}`);

  console.log(`[4/10] confirm SO → fires PO cascade`);
  const confirmR = await call("POST", `/api/sales-orders/${soId}/confirm`, {
    changedBy: "SmokeTest",
    notes: "onhold-cascade test",
  });
  ok(
    confirmR.status === 200 && confirmR.data.success === true,
    `SO confirmed (${confirmR.status})`,
  );
  const confirmPOs = (confirmR.data.productionOrders as AnyRec[]) ?? [];
  ok(confirmPOs.length >= 1, `at least one PO created (got ${confirmPOs.length})`);

  console.log(`[5/10] verify PO exists in production_orders`);
  const poListR = await call("GET", "/api/production-orders");
  const allPos = (poListR.data.data as AnyRec[]) ?? [];
  const ourPos = allPos.filter((p) => (p.salesOrderId as string) === soId);
  ok(ourPos.length >= 1, `found ${ourPos.length} PO(s) for this SO`);
  const ourPoIds = new Set(ourPos.map((p) => p.id as string));

  console.log(`[6/10] PUT SO → ON_HOLD`);
  const holdR = await call("PUT", `/api/sales-orders/${soId}`, {
    status: "ON_HOLD",
    changedBy: "SmokeTest",
    statusNotes: "Pausing for cascade test",
  });
  ok(
    holdR.status === 200 && holdR.data.success === true,
    `PUT ON_HOLD (${holdR.status})`,
  );
  const holdCascade = (holdR.data.cascade as AnyRec | null) ?? null;
  ok(
    holdCascade !== null && (holdCascade.affectedPoCount as number) >= 1,
    `cascade.affectedPoCount = ${holdCascade?.affectedPoCount}`,
  );

  console.log(`[7/10] verify every PO flipped to ON_HOLD`);
  const afterHoldR = await call("GET", "/api/production-orders");
  const afterHold = ((afterHoldR.data.data as AnyRec[]) ?? []).filter((p) =>
    ourPoIds.has(p.id as string),
  );
  const stillActive = afterHold.filter((p) => (p.status as string) !== "ON_HOLD");
  ok(
    stillActive.length === 0,
    `all ${afterHold.length} PO(s) are ON_HOLD`,
  );
  for (const p of afterHold) {
    console.log(`       • PO ${p.poNo} → ${p.status}`);
  }

  console.log(`[8/10] PUT SO → CONFIRMED (resume)`);
  const resumeR = await call("PUT", `/api/sales-orders/${soId}`, {
    status: "CONFIRMED",
    changedBy: "SmokeTest",
    statusNotes: "Resuming from ON_HOLD",
  });
  ok(
    resumeR.status === 200 && resumeR.data.success === true,
    `PUT CONFIRMED (${resumeR.status})`,
  );
  const resumeCascade = (resumeR.data.cascade as AnyRec | null) ?? null;
  ok(
    resumeCascade !== null && (resumeCascade.affectedPoCount as number) >= 1,
    `resume cascade.affectedPoCount = ${resumeCascade?.affectedPoCount}`,
  );

  console.log(`[9/10] verify every PO back to PENDING`);
  const afterResumeR = await call("GET", "/api/production-orders");
  const afterResume = ((afterResumeR.data.data as AnyRec[]) ?? []).filter((p) =>
    ourPoIds.has(p.id as string),
  );
  const notPending = afterResume.filter((p) => (p.status as string) !== "PENDING");
  ok(
    notPending.length === 0,
    `all ${afterResume.length} PO(s) back to PENDING`,
  );
  for (const p of afterResume) {
    console.log(`       • PO ${p.poNo} → ${p.status}`);
  }

  console.log(`[10/10] cleanup — DELETE test SO`);
  // The SO is CONFIRMED so DELETE will currently 404/400-out unless the route
  // allows it. Try it anyway — the worst case is the row stays around flagged
  // with the test reference string above.
  const delR = await call("DELETE", `/api/sales-orders/${soId}`);
  if (delR.status >= 400) {
    console.log(
      `       (note: DELETE returned ${delR.status}; manual cleanup may be needed for SO ${soId})`,
    );
  } else {
    console.log(`       deleted SO ${soId}`);
  }

  console.log("\nPASS: ON_HOLD / RESUME cascade working end-to-end.");
}

main().catch((err) => {
  console.error("SMOKE TEST ERROR:", err);
  process.exit(1);
});
