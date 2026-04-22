// Insert 2 sofa-category pillow accessories so the user can set up their
// BOMs. Sheet puts them in ACCESSORIES; user requested SOFA category so
// they surface in the Sofa module and share the sofa master BOM pickers.
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

const rows = [
  {
    code: "LONG PILLOW",
    name: "SOFA LONG PILLOW (12\"X28\")",
    description: "Sofa long pillow 12x28",
    sizeCode: "12X28",
    sizeLabel: "12\" X 28\"",
    fabricUsage: 0,
    unitM3: 0.044,
    basePriceSen: 4000,
    baseModel: "LONG PILLOW",
  },
  {
    code: "SQUARE PILLOW",
    name: "SOFA SQUARE PILLOW (16\"X16\")",
    description: "Sofa square pillow 16x16",
    sizeCode: "16X16",
    sizeLabel: "16\" X 16\"",
    fabricUsage: 0,
    unitM3: 0.034,
    basePriceSen: 2500,
    baseModel: "SQUARE PILLOW",
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
    const pRes = await fetch(`${PROD}/api/products`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ category: "SOFA", status: "ACTIVE", ...p }),
    });
    const pJson = (await pRes.json()) as {
      success: boolean;
      error?: string;
      data?: { id: string };
    };
    if (!pJson.success || !pJson.data) {
      console.log(`  x ${p.code}: ${pJson.error || pRes.status}`);
      continue;
    }
    console.log(`  + ${p.code} -> id=${pJson.data.id}`);

    // Empty bom_templates row so user can edit in BOM page.
    const bRes = await fetch(`${PROD}/api/bom/templates`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        productCode: p.code,
        baseModel: p.baseModel,
        category: "SOFA",
        l1Processes: [],
        wipComponents: [],
        version: "1.0",
        versionStatus: "ACTIVE",
      }),
    });
    const bJson = (await bRes.json()) as { success: boolean; error?: string };
    console.log(
      `    bom_templates: ${bJson.success ? "ok" : bJson.error || bRes.status}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
