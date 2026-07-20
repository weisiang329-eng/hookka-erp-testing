import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = process.cwd();
const WORKER = resolve(ROOT, "src/api/worker.ts");
const ROUTES_DIR = resolve(ROOT, "src/api/routes");
const AUTH_MIDDLEWARE = resolve(ROOT, "src/api/lib/auth-middleware.ts");
const OUTPUT = resolve(ROOT, "docs/generated/api-contract-inventory.json");
const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MUTATIONS = new Set(["post", "put", "patch", "delete"]);

function sourceFile(filename) {
  return ts.createSourceFile(
    filename,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function posix(filename) {
  return relative(ROOT, filename).split(sep).join("/");
}

function joinRoute(prefix, routePath) {
  if (!prefix) return routePath;
  if (routePath === "/") return prefix;
  return `${prefix.replace(/\/$/, "")}/${routePath.replace(/^\//, "")}`;
}

function analyseWorker() {
  const sf = sourceFile(WORKER);
  const imports = new Map();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const local = statement.importClause?.name?.text;
    const specifier = statement.moduleSpecifier.text;
    if (local && specifier.startsWith("./routes/")) {
      imports.set(local, resolve(dirname(WORKER), `${specifier}.ts`));
    }
  }

  let authGatePos = Number.POSITIVE_INFINITY;
  const mounts = new Map();

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(sf);
      const method = node.expression.name.text;
      if (owner === "app" && method === "use" && node.arguments.some((arg) => arg.getText(sf) === "authMiddleware")) {
        authGatePos = node.getStart(sf);
      }
      if (
        owner === "app" &&
        method === "route" &&
        ts.isStringLiteral(node.arguments[0]) &&
        ts.isIdentifier(node.arguments[1])
      ) {
        const filename = imports.get(node.arguments[1].text);
        if (filename) {
          const entries = mounts.get(filename) ?? [];
          entries.push({ prefix: node.arguments[0].text, position: node.getStart(sf) });
          mounts.set(filename, entries);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { authGatePos, mounts };
}

function authBypasses() {
  const sf = sourceFile(AUTH_MIDDLEWARE);
  const result = { exact: [], prefixes: [] };
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const target =
        node.name.text === "PUBLIC_PATHS"
          ? result.exact
          : node.name.text === "PUBLIC_PREFIXES"
            ? result.prefixes
            : null;
      if (target) {
        for (const element of node.initializer.elements) {
          if (ts.isStringLiteral(element)) target.push(element.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

function authSurface(fullPaths, mountedBeforeAuth, bypasses) {
  if (mountedBeforeAuth) return "public-or-self-authenticated";
  if (
    fullPaths.every(
      (path) =>
        bypasses.exact.includes(path) ||
        bypasses.prefixes.some(
          (prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix),
        ),
    )
  ) {
    return "auth-bypass-self-authenticated";
  }
  return "dashboard-authenticated";
}

function signal(text, pattern) {
  return pattern.test(text);
}

function scanFile(filename, workerInfo, bypasses) {
  const sf = sourceFile(filename);
  const endpoints = [];
  const isWorker = filename === WORKER;
  const mounts = isWorker
    ? [{ prefix: "", position: 0 }]
    : (workerInfo.mounts.get(filename) ?? []);

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sf) === "app" &&
      METHODS.has(node.expression.name.text) &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const method = node.expression.name.text;
      const routePath = node.arguments[0].text;
      const handler = [...node.arguments]
        .reverse()
        .find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      const handlerText = handler?.getText(sf) ?? "";
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const mountEntries = mounts.length > 0 ? mounts : [{ prefix: "", position: -1 }];
      const fullPaths = mountEntries.map(({ prefix }) => joinRoute(prefix, routePath));
      const mountedBeforeAuth = isWorker
        ? node.getStart(sf) < workerInfo.authGatePos
        : mountEntries.every(({ position }) => position < workerInfo.authGatePos);

      endpoints.push({
        file: posix(filename),
        line,
        method: method.toUpperCase(),
        routePath,
        mountPrefixes: mountEntries.map(({ prefix }) => prefix),
        fullPaths,
        authSurface: authSurface(fullPaths, mountedBeforeAuth, bypasses),
        signals: {
          readsJsonBody: signal(handlerText, /\.req\.json\s*[<(]/),
          schemaValidation: signal(
            handlerText,
            /\b(?:safeParse|parseWithSchema|validateWithSchema)\s*\(|\bz\.[A-Za-z]+\s*\(/,
          ),
          manualValidation: signal(
            handlerText,
            /status\s*:\s*400|,\s*400\s*\)|HTTPException\s*\(\s*400/,
          ),
          permissionCheck: signal(
            handlerText,
            /\brequire(?:Permission|SuperAdmin)\s*\(/,
          ),
          tenantScope: signal(
            handlerText,
            /\b(?:getOrgId|withOrgScope)\s*\(|\borgId\b|\borg_id\b/,
          ),
          idempotency: signal(handlerText, /\bwithIdempotency\s*\(/),
          transactionOrBatch: signal(
            handlerText,
            /\.batch\s*\(|\.begin\s*\(|\btransaction\b/i,
          ),
        },
        handlerKind: handler ? "inline" : "referenced-or-generated",
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return endpoints;
}

export function buildApiContractInventory() {
  const workerInfo = analyseWorker();
  const bypasses = authBypasses();
  const files = [
    WORKER,
    ...readdirSync(ROUTES_DIR)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => resolve(ROUTES_DIR, name)),
  ];
  const endpoints = files
    .flatMap((filename) => scanFile(filename, workerInfo, bypasses))
    .sort((a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.method.localeCompare(b.method),
    );
  const mutating = endpoints.filter(({ method }) => MUTATIONS.has(method.toLowerCase()));
  const jsonMutations = mutating.filter(({ signals }) => signals.readsJsonBody);
  const nonDashboardMutations = mutating.filter(
    ({ authSurface }) => authSurface !== "dashboard-authenticated",
  );

  return {
    formatVersion: 1,
    source: "TypeScript AST; signals identify review targets and are not proof of safety",
    summary: {
      scannedFiles: files.length,
      endpointDeclarations: endpoints.length,
      mutatingDeclarations: mutating.length,
      nonDashboardAuthenticatedMutations: nonDashboardMutations.length,
      jsonBodyMutations: jsonMutations.length,
      jsonBodyMutationsWithSchemaValidation: jsonMutations.filter(
        ({ signals }) => signals.schemaValidation,
      ).length,
      mutatingWithPermissionCheck: mutating.filter(
        ({ signals }) => signals.permissionCheck,
      ).length,
      mutatingWithTenantSignal: mutating.filter(({ signals }) => signals.tenantScope)
        .length,
      mutatingWithIdempotency: mutating.filter(({ signals }) => signals.idempotency)
        .length,
    },
    endpoints,
  };
}

export function serialiseApiContractInventory(inventory = buildApiContractInventory()) {
  const files = [...new Set(inventory.endpoints.map(({ file }) => file))];
  const fileIndex = new Map(files.map((file, index) => [file, index]));
  const authCodes = {
    "dashboard-authenticated": "dashboard",
    "auth-bypass-self-authenticated": "self-auth",
    "public-or-self-authenticated": "pre-auth",
  };
  const compact = {
    formatVersion: inventory.formatVersion,
    source: inventory.source,
    summary: inventory.summary,
    signalBits: {
      readsJsonBody: 1,
      schemaValidation: 2,
      manualValidation: 4,
      permissionCheck: 8,
      tenantScope: 16,
      idempotency: 32,
      transactionOrBatch: 64,
    },
    endpointColumns: [
      "fileIndex",
      "line",
      "method",
      "routePath",
      "fullPaths",
      "auth",
      "signalMask",
      "handlerKind",
    ],
    files,
    endpoints: inventory.endpoints.map((endpoint) => {
      let mask = 0;
      if (endpoint.signals.readsJsonBody) mask |= 1;
      if (endpoint.signals.schemaValidation) mask |= 2;
      if (endpoint.signals.manualValidation) mask |= 4;
      if (endpoint.signals.permissionCheck) mask |= 8;
      if (endpoint.signals.tenantScope) mask |= 16;
      if (endpoint.signals.idempotency) mask |= 32;
      if (endpoint.signals.transactionOrBatch) mask |= 64;
      return [
        fileIndex.get(endpoint.file),
        endpoint.line,
        endpoint.method,
        endpoint.routePath,
        endpoint.fullPaths,
        authCodes[endpoint.authSurface],
        mask,
        endpoint.handlerKind === "inline" ? "inline" : "reference",
      ];
    }),
  };
  return `${JSON.stringify(compact)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const generated = serialiseApiContractInventory();
  if (process.argv.includes("--write")) {
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, generated, "utf8");
    console.log(`Wrote ${posix(OUTPUT)}`);
  } else if (process.argv.includes("--check")) {
    const existing = readFileSync(OUTPUT, "utf8");
    if (existing !== generated) {
      console.error("API contract inventory is stale. Run npm run api:contracts:write.");
      process.exit(1);
    }
    console.log("API contract inventory is current.");
  } else {
    console.log(generated);
  }
}
