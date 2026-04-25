import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

test('core project files exist', () => {
  assert.ok(existsSync(resolve(root, 'package.json')));
  assert.ok(existsSync(resolve(root, 'wrangler.toml')));
  assert.ok(existsSync(resolve(root, 'src/layouts/DashboardLayout.tsx')));
  assert.ok(existsSync(resolve(root, 'src/components/layout/tabbed-outlet.tsx')));
});

test('enterprise architecture and review docs exist', () => {
  assert.ok(existsSync(resolve(root, 'docs/ENTERPRISE-ERP-ARCHITECTURE.md')));
  assert.ok(existsSync(resolve(root, 'docs/REPO-REVIEW-2026-04-24.md')));
});

test('cloudflare pages output configured', () => {
  const wrangler = read('wrangler.toml');
  assert.match(wrangler, /pages_build_output_dir\s*=\s*"dist"/);
});

test('npm scripts include test/build/typecheck/lint', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(typeof pkg.scripts.test, 'string');
  assert.equal(typeof pkg.scripts.build, 'string');
  assert.equal(typeof pkg.scripts.typecheck, 'string');
  assert.equal(typeof pkg.scripts.lint, 'string');
});
