import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Underscore-prefix = intentionally unused. Standard TS convention
      // for args that exist for signature compatibility and for
      // destructured tuple slots that are positional placeholders.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // Barrel export files re-export components + types + helpers. That's
  // their entire purpose, so the react-refresh "only components" rule
  // should not apply to them.
  {
    files: ['src/components/ui/index.ts', 'src/**/index.ts'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // Mixed-export files: the components co-live with a small helper /
  // constant / hook that is tightly coupled to them (buttonVariants CVA,
  // useToast hook, getAnyStatusStyle fallback). Splitting them would
  // hurt DX without improving HMR. Router.tsx is also here: it exports
  // a RouteObject config, not a component, so fast-refresh does not
  // apply.
  {
    files: [
      'src/router.tsx',
      // dashboard-routes.tsx exports DASHBOARD_ROUTES (RouteObject[]) and
      // DASHBOARD_ROUTE_ELEMENTS — config, not components. Same rationale
      // as router.tsx; fast-refresh does not apply.
      'src/dashboard-routes.tsx',
      'src/components/ui/button.tsx',
      'src/components/ui/toast.tsx',
      'src/components/ui/status-badge.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // Sprint 5 — Bundle hygiene. Pages and shared UI components must not
  // value-import from @/lib/mock-data: that file pulls in ~326KB of seed
  // data (production orders, sales orders, BOM rows, etc.) that is only
  // used by the legacy /api/routes-mock fallback and never needed by the
  // SPA. Type-only imports are still allowed (zero runtime cost under
  // verbatimModuleSyntax) but new code should prefer @/types and
  // @/lib/pricing-options as the canonical sources.
  {
    files: ['src/pages/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/lib/mock-data',
              importNames: [],
              message:
                'Do not value-import from @/lib/mock-data in pages/components — it bundles seed data into the page chunk. Use @/types for types and @/lib/pricing-options for pricing constants. Type-only imports (`import type`) are erased at build time and remain allowed.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // P4.2 — Scheduler policy. Block raw setInterval / setTimeout in app code;
  // every recurring timer must go through the visibility-aware wrappers in
  // src/lib/scheduler.ts so it pauses on document.hidden and clears on
  // unmount. Severity is "warn" today because P4.3 (call-site migration of
  // 30+ existing raw timers) has not landed yet — flipping to "error" before
  // that lands would block every commit touching a file with a raw timer
  // via lint-staged. Once P4.3 drains the count to zero, flip both rules to
  // "error" in the same commit. See docs/UPGRADE-CONTROL-BOARD.md (Phase 4).
  //
  // Allowlist: the wrapper itself (which IS the implementation) and the
  // two existing visibility-aware hooks that served as the template for the
  // wrapper (use-presence, use-version-check). Those have hand-rolled
  // visibility logic that we do not want to migrate — they are the
  // reference implementation.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/scheduler.ts',
      'src/lib/use-presence.ts',
      'src/lib/use-version-check.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector: "CallExpression[callee.name='setInterval']",
          message:
            'Use useInterval from src/lib/scheduler.ts (visibility-aware, auto-cleanup). See docs/UPGRADE-CONTROL-BOARD.md P4.1.',
        },
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message:
            'Use useTimeout from src/lib/scheduler.ts. If running outside React (event handlers, module init, non-component utilities), suppress with `// eslint-disable-next-line no-restricted-syntax` and a one-line reason.',
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='setInterval']",
          message:
            'Use useInterval from src/lib/scheduler.ts (visibility-aware, auto-cleanup).',
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='setTimeout']",
          message:
            'Use useTimeout from src/lib/scheduler.ts (or eslint-disable with a reason for non-React call sites).',
        },
      ],
    },
  },
])
