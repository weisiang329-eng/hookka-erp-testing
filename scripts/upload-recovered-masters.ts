// One-shot: read recovered-bom-templates.json and POST the master templates
// to /api/bom-master-templates on prod. Safe to re-run — the backend PUT is
// idempotent per id.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const recoveredFile = path.join(repoRoot, "recovered-bom-templates.json");

const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

type Entry = {
  profile: string;
  origin: string;
  key: string;
  value: unknown;
};

type RecoveredDoc = {
  entries: Entry[];
};

async function login(): Promise<string> {
  const res = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await res.json()) as { data?: { token?: string } };
  const t = j?.data?.token;
  if (!t) throw new Error("Login failed: " + JSON.stringify(j));
  return t;
}

async function main() {
  const raw = fs.readFileSync(recoveredFile, "utf8");
  const doc = JSON.parse(raw) as RecoveredDoc;

  // Pick only the bom-master-template-* entries (not the index, not the
  // hookka-bom-templates-v2 blobs). Deduplicate by key — if multiple profiles
  // have the same key, prefer the most-populated value.
  const byKey = new Map<string, Entry>();
  for (const e of doc.entries) {
    if (!e.key.startsWith("bom-master-template-") || e.key === "bom-master-templates-index") continue;
    if (!e.value || typeof e.value !== "object") continue;
    const existing = byKey.get(e.key);
    const weight = JSON.stringify(e.value).length;
    const existingWeight = existing ? JSON.stringify(existing.value).length : -1;
    if (weight > existingWeight) byKey.set(e.key, e);
  }

  const templates = [...byKey.values()].map((e) => {
    const v = e.value as Record<string, unknown>;
    // Category fallback: respect the stored value, only guess if missing.
    const storedCat = typeof v.category === "string" ? v.category : "";
    const guessedCat =
      (typeof v.id === "string" && v.id.toUpperCase().includes("SOFA"))
        ? "SOFA"
        : "BEDFRAME";
    const category =
      storedCat === "BEDFRAME" || storedCat === "SOFA" ? storedCat : guessedCat;
    return {
      id: (v.id as string) || e.key.replace(/^bom-master-template-/, "") || "BEDFRAME",
      category,
      label: (v.label as string) || "Recovered",
      moduleKey: v.moduleKey,
      isDefault: (v.isDefault as boolean) ?? false,
      l1Processes: v.l1Processes ?? [],
      l1Materials: v.l1Materials ?? [],
      wipItems: v.wipItems ?? [],
      updatedAt: (v.updatedAt as string) || new Date().toISOString(),
    };
  });

  console.log(`Uploading ${templates.length} master templates to D1...`);
  for (const t of templates) {
    console.log(`  - ${t.id} (${t.category}, label=${t.label}, wipItems=${Array.isArray(t.wipItems) ? t.wipItems.length : 0})`);
  }

  const token = await login();
  const res = await fetch(`${PROD}/api/bom-master-templates`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ templates, replaceAll: false }),
  });
  const body = await res.text();
  console.log(`\nHTTP ${res.status}`);
  console.log(body.slice(0, 500));

  if (res.ok) {
    // Verify D1 count
    const verify = await fetch(`${PROD}/api/bom-master-templates`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const vj = (await verify.json()) as { data?: unknown[] };
    console.log(`\nD1 verify: ${Array.isArray(vj.data) ? vj.data.length : "?"} templates now in database.`);
  }
}

main().catch((e) => {
  console.error("Upload failed:", e);
  process.exit(1);
});
