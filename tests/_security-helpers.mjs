// ---------------------------------------------------------------------------
// _security-helpers.mjs — shared helpers for the three security regression
// tests (security-public-endpoints / security-permission-matrix /
// security-route-coverage).
//
// The leading underscore is intentional: node's --test glob discovery skips
// files matching tests/*.test.mjs only, so this helper is invisible to the
// test runner and is loaded purely by import statements.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

// ---------------------------------------------------------------------------
// 1. Parse the PUBLIC_PATHS / PUBLIC_PREFIXES arrays out of
//    src/api/lib/auth-middleware.ts.
//
// The constants are not exported (intentionally — middleware-private state),
// so the snapshot test parses the source text instead of importing them.
// ---------------------------------------------------------------------------
export function parsePublicEndpoints() {
  const src = readFileSync(
    resolve(root, "src/api/lib/auth-middleware.ts"),
    "utf8",
  );

  function extractArray(name) {
    // Matches:  const NAME = [ ... ];  or  export const NAME = [ ... ];
    const re = new RegExp(
      `(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`,
    );
    const m = src.match(re);
    if (!m) {
      throw new Error(`parsePublicEndpoints: could not find const ${name}`);
    }
    // Strip line/block comments, then pull out every "..." or '...' literal.
    const body = m[1]
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const items = [...body.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    return items;
  }

  return {
    paths: extractArray("PUBLIC_PATHS"),
    prefixes: extractArray("PUBLIC_PREFIXES"),
  };
}

// ---------------------------------------------------------------------------
// 1b. Parse routes mounted in src/api/worker.ts that come BEFORE
//     `app.use("/api/*", authMiddleware)` — those bypass the auth gate
//     entirely without ever appearing in PUBLIC_PATHS / PUBLIC_PREFIXES.
//     The PUBLIC_PATHS allowlist only governs routes that go THROUGH the
//     middleware; pre-mounted routes are a parallel public surface that
//     also needs snapshotting.
//
// Returns array of "{METHOD} {path}" strings (e.g. "GET /api/health").
// ---------------------------------------------------------------------------
export function parsePreAuthRoutes() {
  const src = readFileSync(resolve(root, "src/api/worker.ts"), "utf8");
  // Find where the auth middleware is registered. Routes registered before
  // this line are public-by-construction.
  const authIdx = src.search(/app\.use\(\s*["']\/api\/\*["']\s*,\s*authMiddleware/);
  if (authIdx < 0) {
    throw new Error("parsePreAuthRoutes: could not locate authMiddleware mount");
  }
  const preAuth = src.slice(0, authIdx);
  // Match `app.<method>("/api/...", ...)` and `app.all("/api/...", ...)`.
  const routes = [];
  const re = /app\.(get|post|put|patch|delete|all)\(\s*["'](\/api\/[^"']+)["']/gi;
  let m;
  while ((m = re.exec(preAuth)) !== null) {
    routes.push(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return routes;
}

// ---------------------------------------------------------------------------
// 2. Parse the seeded role -> Set<"resource:action"> matrix out of
//    migrations/0045_rbac.sql.
//
// 0045 seeds permissions individually, then assigns them to roles via SELECT
// statements that filter on resource/action. We replay that same logic here:
// build a permissions registry, then fold every "INSERT ... SELECT ... FROM
// permissions WHERE ..." statement into the roleId's set.
// ---------------------------------------------------------------------------
export function parseRbacMatrix() {
  const src = readFileSync(
    resolve(root, "migrations/0045_rbac.sql"),
    "utf8",
  );

  // 2a. Pull every (resource, action) tuple out of the
  //     `INSERT OR IGNORE INTO permissions ...` blocks.
  const allPerms = new Set();
  const permRe =
    /\(\s*'perm_[a-z0-9_]+'\s*,\s*'([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'/gi;
  for (const m of src.matchAll(permRe)) {
    allPerms.add(`${m[1]}:${m[2]}`);
  }

  // 2b. Walk every role-permission INSERT block and apply its filter.
  //     We support the three shapes used in 0045:
  //       SELECT 'role_X', id FROM permissions;                                    (all)
  //       SELECT 'role_X', id FROM permissions WHERE action = 'read';              (action filter)
  //       SELECT 'role_X', id FROM permissions WHERE resource IN (...);            (resource list)
  //       SELECT 'role_X', id FROM permissions WHERE action = 'read' AND resource IN (...);
  const matrix = {};
  function add(role, p) {
    if (!matrix[role]) matrix[role] = new Set();
    matrix[role].add(p);
  }

  const blockRe =
    /INSERT OR IGNORE INTO role_permissions \(roleId, permissionId\)\s*SELECT\s+'(role_[a-z_]+)',\s*id\s*FROM\s+permissions([\s\S]*?);/gi;
  for (const m of src.matchAll(blockRe)) {
    const role = m[1];
    const filter = m[2].trim();

    let actionFilter = null;
    let resourceList = null;

    const actionMatch = filter.match(/action\s*=\s*'([a-z0-9-]+)'/i);
    if (actionMatch) actionFilter = actionMatch[1];

    const resourceListMatch = filter.match(
      /resource\s+IN\s*\(([\s\S]*?)\)/i,
    );
    if (resourceListMatch) {
      resourceList = [
        ...resourceListMatch[1].matchAll(/'([a-z0-9-]+)'/gi),
      ].map((x) => x[1]);
    }

    for (const p of allPerms) {
      const [resource, action] = p.split(":");
      if (actionFilter && action !== actionFilter) continue;
      if (resourceList && !resourceList.includes(resource)) continue;
      add(role, p);
    }
  }

  return { allPerms, matrix };
}

// Convenience: load the perm Set for a single roleId.
export function loadPermsForRole(roleId) {
  const { matrix } = parseRbacMatrix();
  return matrix[roleId] ?? new Set();
}

// ---------------------------------------------------------------------------
// 3. Helpers for the route-coverage test.
//
// requirePermission is called inline as `requirePermission(c, "resource",
// "action")` (see src/api/lib/rbac.ts header comment), NOT as a Hono
// middleware. The regex matches the actual call shape.
// ---------------------------------------------------------------------------
export function readRouteSource(relPath) {
  return readFileSync(resolve(root, relPath), "utf8");
}

export function hasPermissionGate(src, resource, action) {
  // Allow any whitespace, the leading `c, ` arg, and either quote style.
  const re = new RegExp(
    `requirePermission\\s*\\(\\s*c\\s*,\\s*["']${escapeRe(resource)}["']\\s*,\\s*["']${escapeRe(action)}["']\\s*\\)`,
  );
  return re.test(src);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
