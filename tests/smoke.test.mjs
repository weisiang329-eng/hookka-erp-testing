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

test('router lazy pages are wrapped in Suspense loading fallback', () => {
  const router = read('src/router.tsx');
  assert.match(router, /function PageLoading\(\)/);
  assert.match(router, /Loading\.\.\./);
  assert.match(router, /<Suspense fallback={<PageLoading \/>}>{children}<\/Suspense>/);
});

test('worker login has explicit loading phase UX on submit buttons', () => {
  const workerLogin = read('src/pages/worker/login.tsx');
  assert.match(workerLogin, /const \[loading, setLoading\] = useState\(false\)/);
  assert.match(workerLogin, /<button type="submit" disabled={loading} className={btnPrimary}>/);
  assert.match(workerLogin, /loading \? t\("common\.loading"\)/);
});

test('deploy workflow runs tests before build', () => {
  const deployWorkflow = read('.github/workflows/deploy.yml');
  const testStep = deployWorkflow.indexOf('- run: npm test');
  const buildStep = deployWorkflow.indexOf('- run: npm run build');
  assert.ok(testStep > -1, 'npm test step should exist');
  assert.ok(buildStep > -1, 'npm run build step should exist');
  assert.ok(testStep < buildStep, 'npm test should run before npm run build');
});
