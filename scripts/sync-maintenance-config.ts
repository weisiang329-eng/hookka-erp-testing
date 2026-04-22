// Fix kv_config variants-config to match the shape that src/pages/products/
// index.tsx (MaintenanceView) expects. The earlier seed script wrote fields
// under wrong keys/shape, so the UI fell back to defaults.
//
//   MaintenanceView expects:
//     { divanHeights: {value, priceSen}[], legHeights: same, totalHeights,
//       gaps: string[], specials: {value, priceSen}[],
//       sofaLegHeights, sofaSpecials, sofaSizes: string[] }
//
//   Earlier seed wrote:
//     divanHeights: {height, priceSen}  <- wrong key
//     gapHeights (should be gaps)
//     sofaSeatSizes (should be sofaSizes)
//     bedframeSpecialOrders (should be specials)
//     sofaSpecialOrders (should be sofaSpecials)
import * as fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const xl = require("xlsx");

const SHEET = "C:/Users/User/Downloads/Production Sheet (9).xlsx";
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

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

type Cell = string | number;
const DQ = '"';

const SOFA_SO_NAMES = new Set([
  "NYLON FABRIC",
  "5537 BACKREST",
  "ADD 1" + DQ + " INFRONT L",
  "ADD 1 INFRONT L",
  "SEPERATE BACKREST PACKING",
  "SEAT ADD ON 4" + DQ,
  "SEAT ADD ON 4",
]);

function parse(wb: { Sheets: Record<string, unknown> }) {
  const ws = wb.Sheets["Other Maint"];
  const rows: Cell[][] = xl.utils.sheet_to_json(ws, { header: 1, defval: "" });

  const divanHeights: Array<{ value: string; priceSen: number }> = [];
  const legHeights: Array<{ value: string; priceSen: number }> = [];
  const gaps: string[] = [];
  const specials: Array<{ value: string; priceSen: number }> = [];
  const sofaSpecials: Array<{ value: string; priceSen: number }> = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    // Divan
    if (r[0] !== "" && r[0] != null) {
      divanHeights.push({
        value: `${r[0]}${DQ}`,
        priceSen: Math.round(Number(r[1]) * 100) || 0,
      });
    }
    // Leg
    if (r[2] !== "" && r[2] != null) {
      legHeights.push({
        value: `${r[2]}${DQ}`,
        priceSen: Math.round(Number(r[3]) * 100) || 0,
      });
    }
    // Gap
    if (r[4] !== "" && r[4] != null) {
      gaps.push(`${r[4]}${DQ}`);
    }
    // Special orders (col F = name, col G = price)
    if (r[5] !== "" && r[5] != null) {
      const name = String(r[5]).trim();
      const priceCell = r[6];
      const priceSen =
        typeof priceCell === "number" ? Math.round(priceCell * 100) : 0;
      if (SOFA_SO_NAMES.has(name.toUpperCase())) {
        sofaSpecials.push({ value: name, priceSen });
      } else {
        specials.push({ value: name, priceSen });
      }
    }
  }

  // Sofa size column
  const header = rows[0] as string[];
  const sofaCol = header.findIndex((h) =>
    String(h).toLowerCase().includes("sofa size"),
  );
  const sofaSizes: string[] = [];
  if (sofaCol >= 0) {
    for (let i = 1; i < rows.length; i++) {
      const v = rows[i]?.[sofaCol];
      if (v !== "" && v != null) sofaSizes.push(`${v}${DQ}`);
    }
  }

  return { divanHeights, legHeights, gaps, sofaSizes, specials, sofaSpecials };
}

async function main() {
  if (!fs.existsSync(SHEET)) throw new Error(`sheet missing: ${SHEET}`);
  const token = await login();
  const auth: HeadersInit = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  const wb = xl.readFile(SHEET);
  const parsed = parse(wb);
  console.log("Parsed:");
  console.log("  divanHeights:", parsed.divanHeights.length);
  console.log("  legHeights:", parsed.legHeights.length);
  console.log("  gaps:", parsed.gaps.length);
  console.log("  sofaSizes:", parsed.sofaSizes.length);
  console.log("  specials:", parsed.specials.length);
  console.log("  sofaSpecials:", parsed.sofaSpecials.length);

  // Pull current config to preserve unrelated fields (fabricGroups,
  // productionTimes, etc. written by BOM).
  const cur = await fetch(`${PROD}/api/kv-config/variants-config`, {
    headers: auth,
  });
  const curJ = (await cur.json()) as { data?: Record<string, unknown> };
  const merged: Record<string, unknown> = {
    ...(curJ.data || {}),
    // Strip the wrong-named keys written by the earlier seed.
    divanHeights: parsed.divanHeights,
    legHeights: parsed.legHeights,
    gaps: parsed.gaps,
    sofaSizes: parsed.sofaSizes,
    specials: parsed.specials,
    sofaSpecials: parsed.sofaSpecials,
    updatedFromSheet: new Date().toISOString(),
  };
  // Drop wrong-shape legacy keys so the UI never reads them again.
  delete merged.gapHeights;
  delete merged.sofaSeatSizes;
  delete merged.bedframeSpecialOrders;
  delete merged.sofaSpecialOrders;

  const putR = await fetch(`${PROD}/api/kv-config/variants-config`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify(merged),
  });
  const putJ = (await putR.json()) as { success: boolean; error?: string };
  console.log("\nPUT variants-config:", putJ.success ? "ok" : "FAIL " + (putJ.error || ""));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
