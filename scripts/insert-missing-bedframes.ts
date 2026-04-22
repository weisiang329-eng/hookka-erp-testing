// One-shot: insert the 4 bedframes that exist in the production sheet but
// not yet in D1, plus create empty bom_templates rows so the bulk reapply
// script can later overlay the right K/Q or SS/S master onto them.
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

type NewProduct = {
  code: string;
  name: string;
  description: string;
  sizeCode: string;
  sizeLabel: string;
  fabricUsage: number;
  unitM3: number;
  basePriceSen: number;
  productionTimeMinutes: number;
  baseModel: string;
};

// Sheet-derived values. Prices are in cents/sen (× 100).
const rows: NewProduct[] = [
  {
    code: "1007-(153X200)",
    name: "CODY BEDFRAME (153X200CM)",
    description: "Cody bedframe 153x200cm",
    sizeCode: "153X200",
    sizeLabel: "153CMX200CM",
    fabricUsage: 2,
    unitM3: 0.894,
    basePriceSen: 80000,
    productionTimeMinutes: 0,
    baseModel: "1007",
  },
  {
    code: "1030-(HF)(W)(SS)",
    name: "TIFANNY BEDFRAME (HF)(W) (3.5FT) (107X190CM)",
    description: "Tifanny HF+W, SS size",
    sizeCode: "SS",
    sizeLabel: "3.5FT",
    fabricUsage: 3,
    unitM3: 0.58,
    basePriceSen: 39000,
    productionTimeMinutes: 0,
    baseModel: "1030(HF)(W)",
  },
  {
    code: "2023-(S)",
    name: "ADJUSTABLE BEDFRAME (3FT)",
    description: "2023 adjustable S",
    sizeCode: "S",
    sizeLabel: "3FT",
    fabricUsage: 10,
    unitM3: 0.35,
    basePriceSen: 56000,
    productionTimeMinutes: 0,
    baseModel: "2023",
  },
  {
    code: "2049-(K)",
    name: "FENRIR ADJUSTABLE BEDFRAME (6FT)",
    description: "Fenrir adjustable K",
    sizeCode: "K",
    sizeLabel: "6FT",
    fabricUsage: 0,
    unitM3: 0,
    basePriceSen: 0,
    productionTimeMinutes: 0,
    baseModel: "2049",
  },
];

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

async function main() {
  const token = await login();
  const auth: HeadersInit = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  for (const p of rows) {
    // 1. create product
    const pRes = await fetch(`${PROD}/api/products`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ category: "BEDFRAME", status: "ACTIVE", ...p }),
    });
    const pJson = (await pRes.json()) as {
      success: boolean;
      error?: string;
      data?: { id: string };
    };
    if (!pJson.success || !pJson.data) {
      console.log(`  x product ${p.code}: ${pJson.error || pRes.status}`);
      continue;
    }
    console.log(`  + product ${p.code} -> id=${pJson.data.id}`);

    // 2. create empty bom_templates row (reapply script will overlay master)
    const bRes = await fetch(`${PROD}/api/bom/templates`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        productCode: p.code,
        baseModel: p.baseModel,
        category: "BEDFRAME",
        l1Processes: [],
        wipComponents: [],
        version: "1.0",
        versionStatus: "ACTIVE",
      }),
    });
    const bJson = (await bRes.json()) as {
      success: boolean;
      error?: string;
    };
    console.log(
      `    bom_templates ${p.code}: ${bJson.success ? "ok" : bJson.error || bRes.status}`,
    );
  }
  console.log(
    "\nNow run: npx tsx scripts/reapply-masters-to-bedframes.ts\nto overlay K/Q master on 2049-(K)+1007-(153X200) and SS/S master on 1030-(HF)(W)(SS)+2023-(S).",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
