// ---------------------------------------------------------------------------
// Import supplier catalogue from supp.xlsx → REMOTE hookka-erp-testing D1.
//
// The sheet is an AutoCount export (31 rows). We map its columns onto the
// suppliers table extended by migration 0023. Idempotent: suppliers already
// in D1 are PUT-updated; missing ones are POSTed.
//
// Run:   npx tsx scripts/import-suppliers.ts
// Creds: weisiang329@gmail.com / CbpxqJQpjy3VA5yd3Q
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// xlsx is a CJS module — import via require so tsx doesn't choke on it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const xl = require("xlsx") as typeof import("xlsx");

const SHEET = "C:/Users/User/Downloads/supp.xlsx";
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function login(): Promise<string> {
  const r = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await r.json()) as { data?: { token?: string } };
  if (!j.data?.token) throw new Error("login failed");
  return j.data.token;
}

function s(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v).trim();
  return String(v).trim();
}

function numOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  return 0;
}

type SheetRow = {
  code: string;
  name: string;
  phone1: string;
  phone2: string;
  mobile: string;
  fax: string;
  email: string;
  addr1: string;
  addr2: string;
  addr3: string;
  addr4: string;
  secondDescription: string;
  controlAccount: string;
  postalCode: string;
  registrationNo: string;
  outstandingSen: number;
};

function parseSheet(): SheetRow[] {
  const wb = xl.readFile(SHEET);
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error(`Sheet "${wb.SheetNames[0]}" not found`);
  const rows = xl.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: "",
    raw: true,
  });
  const out: SheetRow[] = [];
  for (const r of rows) {
    const code = s(r["Code"]);
    const name = s(r["Company Name"]);
    if (!code || !name) continue;
    out.push({
      code,
      name,
      phone1: s(r["Phone 1"]),
      phone2: s(r["Phone 2"]),
      mobile: s(r["Mobile"]),
      fax: s(r["Fax 1"]),
      email: s(r["Email Address"]),
      addr1: s(r["Address 1"]),
      addr2: s(r["Address 2"]),
      addr3: s(r["Address 3"]),
      addr4: s(r["Address 4"]),
      secondDescription: s(r["2nd Description"]),
      controlAccount: s(r["Control Account"]),
      postalCode: s(r["Post/Zip Code"]),
      registrationNo: s(r["Registration No."]),
      outstandingSen: Math.round(numOrZero(r["Outstanding"]) * 100),
    });
  }
  return out;
}

type ApiSupplier = {
  id: string;
  code: string;
  name: string;
};

// Build the body sent to POST/PUT. Defaults applied where the sheet is silent.
function toBody(r: SheetRow) {
  // Combine address lines into the legacy `address` field so older UI still
  // shows something; new UI should read addressLine1..4 directly.
  const legacyAddress = [r.addr1, r.addr2, r.addr3, r.addr4]
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");

  return {
    code: r.code,
    name: r.name,
    // Legacy fields (preserved for backward compat)
    contactPerson: "",
    phone: r.phone1,
    email: r.email,
    address: legacyAddress,
    state: "",
    paymentTerms: "C.O.D.",
    status: "ACTIVE",
    rating: 3,
    // AutoCount fields
    controlAccount: r.controlAccount,
    creditorType: "",
    registrationNo: r.registrationNo,
    taxEntityTin: "",
    addressLine1: r.addr1,
    addressLine2: r.addr2,
    addressLine3: r.addr3,
    addressLine4: r.addr4,
    postalCode: r.postalCode,
    area: "",
    website: "",
    attention: "",
    agent: "",
    businessNature: "",
    currency: "MYR",
    statementType: "OPEN_ITEM",
    agingOn: "INVOICE_DATE",
    creditTerm: "C.O.D.",
    isActive: true,
    isGroupCompany: false,
    outstandingSen: r.outstandingSen,
    secondDescription: r.secondDescription,
    phone2: r.phone2,
    mobile: r.mobile,
    fax: r.fax,
  };
}

async function main() {
  const sheet = parseSheet();
  console.log(`[import-suppliers] Parsed ${sheet.length} rows from ${SHEET}`);

  const token = await login();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // Fetch existing suppliers — map code → id for idempotent updates.
  const listRes = await fetch(`${PROD}/api/suppliers`, { headers: auth });
  const listJson = (await listRes.json()) as { data?: ApiSupplier[] };
  const existingByCode = new Map<string, ApiSupplier>();
  for (const s of listJson.data ?? []) {
    existingByCode.set(s.code, s);
  }
  console.log(`[import-suppliers] Found ${existingByCode.size} existing suppliers in D1`);

  let created = 0;
  let updated = 0;
  const failures: Array<{ code: string; reason: string }> = [];

  for (const row of sheet) {
    const body = toBody(row);
    const existing = existingByCode.get(row.code);
    try {
      if (existing) {
        const r = await fetch(`${PROD}/api/suppliers/${existing.id}`, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const txt = await r.text();
          failures.push({ code: row.code, reason: `PUT ${r.status}: ${txt.slice(0, 200)}` });
          continue;
        }
        updated++;
      } else {
        const r = await fetch(`${PROD}/api/suppliers`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const txt = await r.text();
          failures.push({ code: row.code, reason: `POST ${r.status}: ${txt.slice(0, 200)}` });
          continue;
        }
        created++;
      }
    } catch (e) {
      failures.push({ code: row.code, reason: String((e as Error).message ?? e) });
    }
  }

  console.log(`[import-suppliers] Done at ${new Date().toISOString()}`);
  console.log(`[import-suppliers] created=${created} updated=${updated} failed=${failures.length}`);
  if (failures.length) {
    for (const f of failures) {
      console.log(`  FAIL ${f.code}: ${f.reason}`);
    }
  }
}

main().catch((e) => {
  console.error("[import-suppliers] fatal:", e);
  process.exit(1);
});
