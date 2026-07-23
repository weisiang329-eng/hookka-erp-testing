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
  assert.ok(existsSync(resolve(root, 'src/components/layout/breadcrumbs.tsx')));
});

test('enterprise architecture and review docs exist', () => {
  assert.ok(existsSync(resolve(root, 'docs/ENTERPRISE-ERP-ARCHITECTURE.md')));
  assert.ok(existsSync(resolve(root, 'docs/CODEBASE-MAP.md'))); // REPO-REVIEW-2026-04-24 removed in the #101 docs restructure
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

test('worker login has explicit loading phase UX', () => {
  const workerLogin = read('src/pages/worker/login.tsx');
  assert.match(workerLogin, /const \[loading, setLoading\] = useState\(false\)/);
  // Keypad-driven login mode shows a "Loading…" line while the request is
  // in flight; the secondary setup/reset forms keep the disabled submit
  // button. Both read off the same `loading` state + t("common.loading").
  assert.match(workerLogin, /<button type="submit" disabled={loading} className={btnPrimary}>/);
  assert.match(workerLogin, /loading \? t\("common\.loading"\)/);
  assert.match(workerLogin, /t\("common\.loading"\)/);
});

test('worker team-stats endpoint is registered', () => {
  const workerRoutes = read('src/api/routes/worker.ts');
  assert.match(workerRoutes, /app\.get\(\s*["']\/team-stats["']/);
});

test('department-performance route is mounted in api worker', () => {
  const apiWorker = read('src/api/worker.ts');
  assert.match(apiWorker, /app\.route\(\s*["']\/api\/department-performance["']\s*,\s*departmentPerformance\s*\)/);
  assert.ok(existsSync(resolve(root, 'src/api/routes/department-performance.ts')));
});

test('deploy workflow runs tests before build', () => {
  const deployWorkflow = read('.github/workflows/deploy.yml');
  const testStep = deployWorkflow.indexOf('- run: npm test');
  const buildStep = deployWorkflow.indexOf('- run: npm run build');
  assert.ok(testStep > -1, 'npm test step should exist');
  assert.ok(buildStep > -1, 'npm run build step should exist');
  assert.ok(testStep < buildStep, 'npm test should run before npm run build');
});
