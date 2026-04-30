// ---------------------------------------------------------------------------
// google-sheets.ts — Google Sheets API v4 client for Cloudflare Workers.
//
// Mints a service-account JWT against the Google OAuth token endpoint using
// the Web Crypto API (no aws-sdk / googleapis SDK — both pull in node-only
// shims that don't survive the Workers runtime).  Caches the access token in
// module scope for ~50 minutes; tokens are good for 60 minutes from Google.
//
// Auth contract:
//   The caller passes a minimal env shape carrying GOOGLE_SHEETS_SA_KEY (the
//   FULL service-account JSON, stringified).  When that env var is missing
//   getSheetsClient returns null — the route layer / sheets-sync helpers
//   short-circuit silently in that case (fire-and-forget no-op so the build
//   ships safely before the GCP service account is provisioned).
//
// Why Web Crypto and not jsonwebtoken / google-auth-library:
//   The Workers runtime exposes `crypto.subtle` natively and supports
//   importKey + sign for RS256.  This keeps the bundle small and avoids the
//   nodejs_compat polyfill surface for a code path on the request hot side.
// ---------------------------------------------------------------------------

/**
 * Minimal env shape — kept local so this module doesn't depend on the full
 * Hono Env type.  Callers pass `c.env`.
 */
export type GoogleSheetsEnv = {
  GOOGLE_SHEETS_SA_KEY?: string;
  SHEETS_SPREADSHEET_ID?: string;
};

/** Shape of the service-account JSON Google generates. */
type ServiceAccountKey = {
  type: string;
  project_id?: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number; // epoch ms
};

// Module-scope token cache.  Workers are stateless across requests in the
// general case, but a warm isolate may reuse this — saves a JWT mint per
// hot request.  TTL is intentionally short (50 min) to leave a buffer
// before the 60-min Google expiry.
let tokenCache: CachedToken | null = null;
const TOKEN_TTL_MS = 50 * 60 * 1000;

const TOKEN_URI_DEFAULT = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// ---------------------------------------------------------------------------
// Client surface
// ---------------------------------------------------------------------------

export type SheetsValuesGetResponse = {
  range: string;
  majorDimension: string;
  values?: string[][];
};

export type SheetsValuesUpdateBody = {
  range: string;
  majorDimension: "ROWS" | "COLUMNS";
  values: (string | number | null)[][];
};

export type SheetsBatchUpdateRequest = {
  range: string;
  majorDimension: "ROWS" | "COLUMNS";
  values: (string | number | null)[][];
};

export type SheetsClient = {
  valuesGet(spreadsheetId: string, range: string): Promise<SheetsValuesGetResponse>;
  valuesUpdate(
    spreadsheetId: string,
    range: string,
    values: (string | number | null)[][],
  ): Promise<unknown>;
  valuesAppend(
    spreadsheetId: string,
    range: string,
    values: (string | number | null)[][],
  ): Promise<unknown>;
  valuesBatchGet(
    spreadsheetId: string,
    ranges: string[],
  ): Promise<{ valueRanges: SheetsValuesGetResponse[] }>;
  valuesBatchUpdate(
    spreadsheetId: string,
    requests: SheetsBatchUpdateRequest[],
  ): Promise<unknown>;
};

/**
 * Returns a Sheets API client, or null when GOOGLE_SHEETS_SA_KEY is missing.
 * Callers MUST handle the null case (silent no-op for fire-and-forget paths,
 * 503 for explicit admin endpoints).
 */
export function getSheetsClient(env: GoogleSheetsEnv): SheetsClient | null {
  if (!env.GOOGLE_SHEETS_SA_KEY) return null;

  let saKey: ServiceAccountKey;
  try {
    saKey = JSON.parse(env.GOOGLE_SHEETS_SA_KEY);
  } catch (err) {
    console.error("[google-sheets] failed to parse GOOGLE_SHEETS_SA_KEY JSON", err);
    return null;
  }
  if (!saKey.client_email || !saKey.private_key) {
    console.error("[google-sheets] service-account key missing client_email/private_key");
    return null;
  }

  return {
    valuesGet: (spreadsheetId, range) => apiValuesGet(saKey, spreadsheetId, range),
    valuesUpdate: (spreadsheetId, range, values) =>
      apiValuesUpdate(saKey, spreadsheetId, range, values),
    valuesAppend: (spreadsheetId, range, values) =>
      apiValuesAppend(saKey, spreadsheetId, range, values),
    valuesBatchGet: (spreadsheetId, ranges) =>
      apiValuesBatchGet(saKey, spreadsheetId, ranges),
    valuesBatchUpdate: (spreadsheetId, requests) =>
      apiValuesBatchUpdate(saKey, spreadsheetId, requests),
  };
}

// ---------------------------------------------------------------------------
// JWT mint + access-token retrieval (cached)
// ---------------------------------------------------------------------------

async function getAccessToken(saKey: ServiceAccountKey): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }
  const jwt = await mintServiceAccountJwt(saKey);
  const tokenUri = saKey.token_uri || TOKEN_URI_DEFAULT;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(
      `[google-sheets] token endpoint returned ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("[google-sheets] token response missing access_token");
  }
  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  return json.access_token;
}

async function mintServiceAccountJwt(saKey: ServiceAccountKey): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: saKey.client_email,
    scope: SHEETS_SCOPE,
    aud: saKey.token_uri || TOKEN_URI_DEFAULT,
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(textEncoder.encode(JSON.stringify(header)));
  const encodedClaim = base64UrlEncode(textEncoder.encode(JSON.stringify(claim)));
  const signingInput = `${encodedHeader}.${encodedClaim}`;

  const cryptoKey = await importPrivateKey(saKey.private_key);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    textEncoder.encode(signingInput),
  );
  const encodedSig = base64UrlEncode(new Uint8Array(sig));
  return `${signingInput}.${encodedSig}`;
}

const textEncoder = new TextEncoder();

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // The service-account JSON keeps the PEM as a single string with literal
  // \n separators.  Strip the header/footer + collapse whitespace, then
  // base64-decode to get the DER bytes.
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, "");
  const der = base64ToBytes(cleaned);
  return crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Sheets API method wrappers
// ---------------------------------------------------------------------------

async function authedFetch(
  saKey: ServiceAccountKey,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken(saKey);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

async function expectOk(res: Response, op: string): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(
      `[google-sheets] ${op} failed ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return res.json().catch(() => ({}));
}

function encodeRange(range: string): string {
  return encodeURIComponent(range);
}

async function apiValuesGet(
  saKey: ServiceAccountKey,
  spreadsheetId: string,
  range: string,
): Promise<SheetsValuesGetResponse> {
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}`;
  const res = await authedFetch(saKey, url, { method: "GET" });
  return (await expectOk(res, "values.get")) as SheetsValuesGetResponse;
}

async function apiValuesUpdate(
  saKey: ServiceAccountKey,
  spreadsheetId: string,
  range: string,
  values: (string | number | null)[][],
): Promise<unknown> {
  const url =
    `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}` +
    `?valueInputOption=USER_ENTERED`;
  const body: SheetsValuesUpdateBody = {
    range,
    majorDimension: "ROWS",
    values,
  };
  const res = await authedFetch(saKey, url, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return expectOk(res, "values.update");
}

async function apiValuesAppend(
  saKey: ServiceAccountKey,
  spreadsheetId: string,
  range: string,
  values: (string | number | null)[][],
): Promise<unknown> {
  const url =
    `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const body: SheetsValuesUpdateBody = {
    range,
    majorDimension: "ROWS",
    values,
  };
  const res = await authedFetch(saKey, url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return expectOk(res, "values.append");
}

async function apiValuesBatchGet(
  saKey: ServiceAccountKey,
  spreadsheetId: string,
  ranges: string[],
): Promise<{ valueRanges: SheetsValuesGetResponse[] }> {
  const qs = ranges.map((r) => `ranges=${encodeRange(r)}`).join("&");
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${qs}`;
  const res = await authedFetch(saKey, url, { method: "GET" });
  return (await expectOk(res, "values.batchGet")) as {
    valueRanges: SheetsValuesGetResponse[];
  };
}

async function apiValuesBatchUpdate(
  saKey: ServiceAccountKey,
  spreadsheetId: string,
  requests: SheetsBatchUpdateRequest[],
): Promise<unknown> {
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`;
  const body = {
    valueInputOption: "USER_ENTERED",
    data: requests,
  };
  const res = await authedFetch(saKey, url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return expectOk(res, "values.batchUpdate");
}

// ---------------------------------------------------------------------------
// Test/util — clear the cached token (used by tests, not by runtime code).
// ---------------------------------------------------------------------------
export function _clearTokenCacheForTests(): void {
  tokenCache = null;
}
