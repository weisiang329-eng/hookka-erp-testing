// ---------------------------------------------------------------------------
// rbac-files-attachable — BUG-2026-08-21-159.
//
// The owner, after four separate fixes to "View original" failed to make it
// appear: 「fix了那么多次了」. He was right to be angry, and the reason none of
// them worked is here rather than anywhere they were applied.
//
// `/api/files` has gated on `files:create` since it shipped. `files` was NEVER
// in ALL_RESOURCES — and `allExcept()` can only grant what that array lists. So
// every coded role (OFFICE, QA, SALES, R&D, HR) was DENIED, no matter how broad
// its policy read. Only SUPER_ADMIN and ADMIN, on the legacy `*:*` wildcard,
// could attach anything.
//
// The operators who scan the POs are OFFICE. Every save of a scanned customer
// PO, and every save of a supplier invoice's source document, 403'd — and the
// client swallowed it. Two months of documents were never stored, and the four
// fixes in between all corrected the CLIENT, which was never where the wall was.
//
// TWO PROPERTIES, and the second is the one with teeth:
//
//   1. the roles that do the work can attach and read, and cannot delete
//   2. EVERY resource a route actually gates on is registered in ALL_RESOURCES
//
// (2) is the general form. A resource missing from that array is not a narrower
// permission — it is an unreachable feature, and it fails as a 403 raised far
// from the code that caused it.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { permissionsForRole, ALL_RESOURCES } from '../src/api/lib/role-policy.ts';

const can = (set, resource, action) =>
  set.has(`${resource}:${action}`) ||
  set.has(`${resource}:*`) ||
  set.has(`*:${action}`) ||
  set.has(`*:*`);

const WORKING_ROLES = ['OFFICE', 'QA', 'SALES', 'R_AND_D', 'HR'];

test('every working role can attach a document', () => {
  // The whole bug in one assertion. OFFICE is who scans the POs.
  for (const role of WORKING_ROLES) {
    const set = permissionsForRole(role);
    assert.ok(set, `${role} should have a coded policy`);
    assert.equal(
      can(set, 'files', 'create'),
      true,
      `${role} cannot attach a file — the scanned PO and the supplier invoice ` +
        `source document both save through POST /api/files, and a role that ` +
        `cannot reach it loses them SILENTLY`,
    );
    assert.equal(can(set, 'files', 'read'), true, `${role} must be able to open one`);
  }
});

test('no working role can delete an attachment', () => {
  // An attachment is evidence. Removing it is an admin action.
  for (const role of WORKING_ROLES) {
    const set = permissionsForRole(role);
    assert.equal(
      can(set, 'files', 'delete'),
      false,
      `${role} must not be able to delete an attachment`,
    );
  }
});

test('EVERY resource a route gates on is registered in ALL_RESOURCES', () => {
  // The general form of this bug, and the part that stops the next one.
  //
  // `allExcept()` iterates ALL_RESOURCES. A resource that a route checks but
  // this array omits can never be granted to a coded role — the feature is
  // simply unreachable for everyone except an admin, and it fails as a 403
  // raised far from the file that caused it.
  const gated = new Map(); // resource -> the file it was seen in
  const RE = /requirePermission\(\s*c\s*,\s*["']([a-z0-9-]+)["']/g;

  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name).replace(/\\/g, '/');
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(RE)) {
          if (!gated.has(m[1])) gated.set(m[1], p);
        }
      }
    }
  };
  walk('src/api/routes');

  assert.ok(gated.size > 20, `only ${gated.size} gated resources found — the scan is broken`);

  const known = new Set(ALL_RESOURCES);
  const missing = [...gated.entries()].filter(([r]) => !known.has(r));

  assert.deepEqual(
    missing.map(([r, where]) => `${r} (gated in ${where})`),
    [],
    'These resources are checked by a route but missing from ALL_RESOURCES, so ' +
      'allExcept() can never grant them and every coded role is denied:',
  );
});
