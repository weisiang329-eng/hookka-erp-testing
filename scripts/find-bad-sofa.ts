import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const xl = require("xlsx") as typeof import("xlsx");
void xl;

const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

async function login() {
  const r = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await r.json()) as { data?: { token?: string } };
  return j.data!.token!;
}

async function main() {
  const token = await login();
  const sosRes = await (await fetch(`${PROD}/api/sales-orders`, { headers: { Authorization: `Bearer ${token}` } })).json() as { data: Array<{ id: string; customerPO: string }> };

  for (const so of sosRes.data) {
    const f = await (await fetch(`${PROD}/api/sales-orders/${so.id}`, { headers: { Authorization: `Bearer ${token}` } })).json() as { data: { customerPO: string; items: Array<{ productCode: string; productName: string; itemCategory: string; sizeCode: string | null; sizeLabel: string | null; divanHeightInches: number | null }> } };
    for (const it of f.data.items) {
      if (it.itemCategory === "SOFA") {
        const bad = !it.sizeCode || !/^\d+$/.test(it.sizeCode);
        if (bad) {
          console.log(`SO ${so.id}  PO=${f.data.customerPO}  ${it.productCode} (${it.productName})  sizeCode=${JSON.stringify(it.sizeCode)}  label=${JSON.stringify(it.sizeLabel)}  divan=${it.divanHeightInches}`);
        }
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
