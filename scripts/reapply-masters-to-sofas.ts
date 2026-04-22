// Re-apply Master BOM Templates to every sofa product, reading the CURRENT
// D1 state as the base. Safe to re-run whenever the user updates a master.
//
// Overlay rules (suffix after the last `-` in the product code):
//   1A(LHF)          -> master "1A(LHF)"
//   1A(RHF)          -> master "1A(RHF)"
//   1NA              -> master "1NA"
//   1S               -> master "1s"
//   2A(LHF)          -> master "2A(LHF)"
//   2A(RHF)          -> master "2A(RHF)"
//   2NA              -> master "2NA"
//   2S               -> master "2s"
//   3S               -> master "3s"
//   CNR              -> master "Corner"
//   L(LHF), L(RHF)   -> master "L(LHR)"  (single master covers both)
//   anything else    -> master "Default" (e.g. CSL, STOOL)
//
// Bedframes are left untouched (they were already overlaid by
// reapply-masters-to-bedframes.ts).

const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

async function login(): Promise<string> {
  const res = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await res.json()) as { data?: { token?: string } };
  const t = j?.data?.token;
  if (!t) throw new Error("Login failed");
  return t;
}

type Master = {
  id: string;
  category: string;
  label: string;
  l1Processes: unknown[];
  l1Materials: unknown[];
  wipItems: unknown[];
};

type Product = {
  id: string;
  code: string;
  category?: string;
  sizeCode?: string;
  name: string;
  baseModel?: string;
};

type BomRow = {
  id: string;
  productCode: string;
  baseModel?: string;
  category?: string;
  l1Processes: unknown;
  wipComponents: unknown;
  version: string;
  versionStatus: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  changeLog?: string | null;
};

function parseMaybe(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Suffix after the last `-` in the product code. */
function parseSuffix(code: string): string {
  const m = code.match(/-([^-]+)$/);
  return m ? m[1] : "";
}

/** Case-insensitive + whitespace-insensitive master label match. */
function findMaster(masters: Master[], label: string): Master | null {
  const norm = label.trim().toLowerCase();
  return masters.find((m) => (m.label || "").trim().toLowerCase() === norm) || null;
}

/**
 * Map a sofa product's suffix to the intended master label.
 * Returns null if we want to fall back to Default.
 */
function suffixToMasterLabel(suffix: string): string | null {
  const s = suffix.toUpperCase();
  switch (s) {
    case "1A(LHF)":
      return "1A(LHF)";
    case "1A(RHF)":
      return "1A(RHF)";
    case "1NA":
      return "1NA";
    case "1S":
      return "1s";
    case "2A(LHF)":
      return "2A(LHF)";
    case "2A(RHF)":
      return "2A(RHF)";
    case "2NA":
      return "2NA";
    case "2S":
      return "2s";
    case "3S":
      return "3s";
    case "CNR":
      return "Corner";
    case "L(LHF)":
    case "L(RHF)":
      return "L(LHR)";
    default:
      return null; // fall back to Default
  }
}

async function main() {
  const token = await login();
  const auth: HeadersInit = { authorization: `Bearer ${token}` };

  console.log("Fetching fresh master templates, products, and bom_templates from D1...");
  const [mRes, pRes, bRes] = await Promise.all([
    fetch(`${PROD}/api/bom-master-templates`, { headers: auth }),
    fetch(`${PROD}/api/products`, { headers: auth }),
    fetch(`${PROD}/api/bom/templates`, { headers: auth }),
  ]);
  const masters = ((await mRes.json()) as { data: Master[] }).data;
  const products = ((await pRes.json()) as { data: Product[] }).data;
  const bomRows = ((await bRes.json()) as { data: BomRow[] }).data;

  const sofaMasters = masters.filter(
    (m) => (m.category || "").toUpperCase() === "SOFA"
  );
  const defaultMaster = findMaster(sofaMasters, "Default");
  if (!defaultMaster) {
    console.error("No SOFA 'Default' master found — aborting.");
    process.exit(1);
  }
  console.log(`  ${sofaMasters.length} SOFA masters found:`);
  for (const m of sofaMasters) {
    console.log(
      `    ${m.id.padEnd(22)} label="${m.label.trim()}" wips=${m.wipItems.length} (${JSON.stringify(m.wipItems).length}b)`
    );
  }
  console.log(`  ${products.length} products, ${bomRows.length} bom_templates`);

  // Decide which master each sofa product gets.
  const overlay = new Map<string, Master>();
  const perMaster: Record<string, string[]> = {};
  const skipped: string[] = [];

  for (const p of products) {
    if ((p.category || "").toUpperCase() !== "SOFA") continue;

    const suffix = parseSuffix(p.code);
    const wantedLabel = suffixToMasterLabel(suffix);
    let chosen: Master | null = null;

    if (wantedLabel) {
      chosen = findMaster(sofaMasters, wantedLabel);
    }
    if (!chosen) {
      // fall back to Default
      chosen = defaultMaster;
    }

    if (!chosen) {
      skipped.push(p.code);
      continue;
    }

    overlay.set(p.code, chosen);
    const key = chosen.label.trim();
    if (!perMaster[key]) perMaster[key] = [];
    perMaster[key].push(p.code);
  }

  console.log("\nOverlay plan (sofa products -> master):");
  for (const [label, codes] of Object.entries(perMaster).sort()) {
    console.log(`  "${label}"`.padEnd(14) + `: ${codes.length} products`);
  }
  if (skipped.length) {
    console.log(`\n  Skipped (no master available): ${skipped.join(", ")}`);
  }

  // Build payload: every existing bom_templates row, with sofa ones overlaid.
  // Bedframe rows are kept as-is.
  const out = bomRows.map((r) => {
    const m = overlay.get(r.productCode);
    const base = {
      id: r.id,
      productCode: r.productCode,
      baseModel: r.baseModel || r.productCode,
      category: (r.category === "SOFA" ? "SOFA" : "BEDFRAME") as "BEDFRAME" | "SOFA",
      l1Processes: parseMaybe(r.l1Processes),
      wipComponents: parseMaybe(r.wipComponents),
      version: r.version || "1.0",
      versionStatus: r.versionStatus || "ACTIVE",
      effectiveFrom: r.effectiveFrom || new Date().toISOString(),
      effectiveTo: r.effectiveTo ?? null,
      changeLog: r.changeLog ?? null,
    };
    if (m) {
      return {
        ...base,
        category: "SOFA" as const,
        l1Processes: m.l1Processes,
        wipComponents: m.wipItems,
      };
    }
    return base;
  });

  console.log(`\nBulk PUT ${out.length} templates...`);
  const putRes = await fetch(`${PROD}/api/bom/templates`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ templates: out }),
  });
  const putBody = await putRes.text();
  console.log(`HTTP ${putRes.status}`);
  console.log(putBody.slice(0, 300));

  if (!putRes.ok) process.exit(1);

  // Verify: grab one representative sofa for each suffix type.
  console.log("\nSample verify:");
  const vRes = await fetch(`${PROD}/api/bom/templates`, { headers: auth });
  const vj = ((await vRes.json()) as { data: BomRow[] }).data;

  const samples = [
    "5530-1A(LHF)",
    "5530-1A(RHF)",
    "5530-1NA",
    "5530-1S",
    "5530-2A(LHF)",
    "5530-2A(RHF)",
    "5530-2NA",
    "5530-2S",
    "5530-3S",
    "5530-CNR",
    "5530-L(LHF)",
    "5530-L(RHF)",
    "5536-CSL",
    "5537-STOOL",
  ];
  for (const c of samples) {
    const r = vj.find((x) => x.productCode === c);
    if (!r) {
      console.log(`  ${c}: (no row)`);
      continue;
    }
    const wcArr = parseMaybe(r.wipComponents);
    const l0 = wcArr[0] as { wipCode?: string; code?: string } | undefined;
    const wcLen =
      typeof r.wipComponents === "string"
        ? r.wipComponents.length
        : JSON.stringify(r.wipComponents).length;
    const expected = overlay.get(c);
    const expectedSize = expected ? JSON.stringify(expected.wipItems).length : -1;
    console.log(
      `  ${c.padEnd(18)} wcBytes=${String(wcLen).padEnd(6)} expected=${expectedSize}  L0.wipCode=${l0?.wipCode ?? l0?.code ?? "?"}  master=${expected?.label.trim() ?? "?"}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
