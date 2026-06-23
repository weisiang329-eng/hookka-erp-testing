// ---------------------------------------------------------------------------
// mail-from-default.test.mjs — unit tests for pickDefaultFromAddress
// (src/pages/mail-center/mail-from-default.ts).
//
// Both the New-email composer and the Reply box default the "From" to the
// logged-in user's OWN mailbox via this helper. These tests pin:
//   - assigned-to-user match wins (strongest signal)
//   - exact address == login email match
//   - local-part match (login email on a different domain than the mailbox)
//   - SAFE FALLBACK: returns "" when the user maps to no address (caller keeps
//     its existing default — must never blank the form)
//   - match priority order (assignment > exact email > local-part)
//
// Pure helper — no DB, no network, no React.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

try {
  register('tsx/esm', pathToFileURL('./'));
} catch {
  // Native type-stripping handles it on newer Node.
}

const mod = await import('../src/pages/mail-center/mail-from-default.ts');
const { pickDefaultFromAddress } = mod;

const ADDRS = [
  { id: 'a1', address: 'support@hookka.com', assignedUserId: 'u-support' },
  { id: 'a2', address: 'lim@hookka.com', assignedUserId: 'u-lim' },
  { id: 'a3', address: 'sales@hookka.com', assignedUserId: null },
];

test('assigned-to-user match wins', () => {
  const got = pickDefaultFromAddress(ADDRS, { id: 'u-lim', email: 'whatever@x.com' });
  assert.equal(got, 'lim@hookka.com');
});

test('exact address == login email match (no assignment)', () => {
  const got = pickDefaultFromAddress(ADDRS, { id: 'u-none', email: 'SALES@hookka.com' });
  assert.equal(got, 'sales@hookka.com');
});

test('local-part match when login domain differs from mailbox', () => {
  const got = pickDefaultFromAddress(ADDRS, { id: 'u-none', email: 'lim@gmail.com' });
  assert.equal(got, 'lim@hookka.com');
});

test('safe fallback: no mapping → "" (caller keeps its default)', () => {
  const got = pickDefaultFromAddress(ADDRS, { id: 'admin', email: 'boss@external.com' });
  assert.equal(got, '');
});

test('empty address list → ""', () => {
  assert.equal(pickDefaultFromAddress([], { id: 'u-lim', email: 'lim@hookka.com' }), '');
});

test('null / missing user → "" (no email, no id)', () => {
  assert.equal(pickDefaultFromAddress(ADDRS, null), '');
  assert.equal(pickDefaultFromAddress(ADDRS, {}), '');
});

test('assignment beats a different exact-email match', () => {
  // user assigned to support@, but their login email is sales@hookka.com:
  // assignment must win.
  const got = pickDefaultFromAddress(ADDRS, {
    id: 'u-support',
    email: 'sales@hookka.com',
  });
  assert.equal(got, 'support@hookka.com');
});

test('exact email beats a local-part-only match', () => {
  const addrs = [
    { id: 'x1', address: 'lim@other.com', assignedUserId: null },
    { id: 'x2', address: 'lim@hookka.com', assignedUserId: null },
  ];
  // login email lim@hookka.com → exact match must win over lim@other.com.
  const got = pickDefaultFromAddress(addrs, { id: 'u', email: 'lim@hookka.com' });
  assert.equal(got, 'lim@hookka.com');
});
