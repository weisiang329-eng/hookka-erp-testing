// ---------------------------------------------------------------------------
// sales-pipeline-lead-detail.test.mjs — CRM redesign slice 1 (owner 2026-07-30).
//
// The Sales Pipeline must be a real board: cards DRAG between columns, and
// clicking a card opens a Lead detail drawer that carries the FULL CRM record
// (Contacts, Activity timeline, Wishlist, KYC) keyed on the lead id — so any
// salesperson can take over. Email inputs are shape-validated.
// See docs/plans/2026-07-30-crm-unified-customer.md.
//
// Source-level structural pins (house style — no DOM render).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LEADS = resolve(process.cwd(), "src/pages/leads/index.tsx");
const src = readFileSync(LEADS, "utf8");
const flat = src.replace(/\s+/g, " ");

test("drag-drop: cards are draggable and columns drop → moveStage", () => {
  assert.match(flat, /draggable/, "cards must be draggable");
  assert.match(flat, /onDragStart=\{/, "cards need a drag-start handler");
  assert.match(flat, /onDrop=\{/, "columns need a drop handler");
  // The drop resolves the dragged lead and moves it to the column's stage.
  assert.match(flat, /onDrop=\{[\s\S]*?moveStage\(lead, s\.key\)/);
  // A drag-over affordance highlights the target column.
  assert.match(flat, /dragOverStage/);
});

test("clicking a card opens the Lead detail drawer", () => {
  assert.match(flat, /onClick=\{\(\) => setOpenLeadId\(l\.id\)\}/);
  assert.match(flat, /openLead &&[\s\S]*?<LeadDetailDrawer/);
});

test("Lead detail drawer mounts the full CRM record keyed on the LEAD id", () => {
  // Same panels a Customer has — the takeover requirement.
  assert.match(flat, /import \{ CrmPanel \} from "@\/components\/customer\/CrmPanel"/);
  assert.match(flat, /import \{ WishlistPanel \} from "@\/components\/customer\/WishlistPanel"/);
  assert.match(flat, /import \{ KycPanel \} from "@\/components\/customer\/KycPanel"/);
  // Keyed on lead.id (the shared entity id), not a customer id.
  assert.match(flat, /<CrmPanel customerId=\{lead\.id\}/);
  assert.match(flat, /<WishlistPanel customerId=\{lead\.id\} \/>/);
  assert.match(flat, /<KycPanel customerId=\{lead\.id\} \/>/);
});

test("stage move is optimistic then reconciled from the server", () => {
  const i = src.indexOf("const moveStage");
  assert.ok(i !== -1);
  const body = src.slice(i, src.indexOf("}, [reload]);", i));
  assert.match(body, /setLeads\(\(prev\) =>/, "optimistic local move");
  assert.match(body, /await fetch\(`\/api\/sales-leads\/\$\{lead\.id\}\/stage`/);
  assert.match(body, /await reload\(\)/, "reconcile from server");
});

test("email inputs are shape-validated and gate submit", () => {
  assert.match(flat, /function emailValid\(v: string\): boolean/);
  // Add form + drawer both block save on an invalid email.
  assert.match(flat, /!emailValid\(form\.email\)/);
  assert.match(flat, /!emailValid\(draft\.email\)/);
});
