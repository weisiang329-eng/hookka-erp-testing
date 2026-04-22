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
      'src/components/ui/button.tsx',
      'src/components/ui/toast.tsx',
      'src/components/ui/status-badge.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
