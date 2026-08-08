// ---------------------------------------------------------------------------
// _alias-loader.mjs — resolves the app's "@/..." import alias for tests.
//
// `npm test` runs node with `--import tsx/esm`, which compiles TS/TSX fine but
// reads the ROOT tsconfig.json — a project-references stub with no `paths` — so
// `@/lib/utils` (declared in tsconfig.app.json) does not resolve and any test
// that imports a src/components file dies with ERR_MODULE_NOT_FOUND.
//
// Register this from inside a test (`register("./tests/_alias-loader.mjs", …)`)
// BEFORE importing the module under test. Loaders registered later run first,
// so this rewrites "@/x" to a real file URL and hands the result to tsx, which
// then does the compiling as usual.
//
// Not a *.test.mjs file, so the `tests/*.test.mjs` glob never runs it directly
// (same convention as _security-helpers.mjs).
// ---------------------------------------------------------------------------
import { pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const SRC = resolvePath(process.cwd(), "src");
const CANDIDATES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = resolvePath(SRC, specifier.slice(2));
    for (const ext of CANDIDATES) {
      const candidate = base + ext;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
