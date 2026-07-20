import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApiContractInventory,
  serialiseApiContractInventory,
} from "../scripts/api-contract-inventory.mjs";

const inventory = buildApiContractInventory();

test("API inventory discovers the full route surface deterministically", () => {
  assert.ok(inventory.summary.scannedFiles > 100);
  assert.ok(inventory.summary.endpointDeclarations > 500);
  assert.ok(inventory.summary.mutatingDeclarations > 450);
  assert.equal(
    serialiseApiContractInventory(inventory),
    serialiseApiContractInventory(buildApiContractInventory()),
  );
});

test("critical money routes expose review signals and mounted full paths", () => {
  const paymentCreate = inventory.endpoints.find(
    ({ file, method, routePath }) =>
      file.endsWith("/payments.ts") && method === "POST" && routePath === "/",
  );
  assert.ok(paymentCreate);
  assert.ok(paymentCreate.fullPaths.includes("/api/payments"));
  assert.equal(paymentCreate.authSurface, "dashboard-authenticated");
  assert.equal(paymentCreate.signals.readsJsonBody, true);
  assert.equal(paymentCreate.signals.permissionCheck, true);
  assert.equal(paymentCreate.signals.tenantScope, true);
  assert.equal(paymentCreate.signals.idempotency, true);
});

test("inventory labels pre-auth mutation surfaces for explicit review", () => {
  const publicMutations = inventory.endpoints.filter(
    ({ method, authSurface }) =>
      method !== "GET" && authSurface !== "dashboard-authenticated",
  );
  assert.ok(publicMutations.length > 0);
  assert.ok(
    publicMutations.some(({ fullPaths }) =>
      fullPaths.some((path) => path.startsWith("/api/internal/")),
    ),
  );
});
