// ---------------------------------------------------------------------------
// totp-login-password-gate.test.mjs — BUG-2026-08-13-101.
//
// `POST /api/auth/totp/login-verify` took { userId, code } and issued a full
// session. Nothing proved step 1 had ever happened, so for an enrolled user the
// PASSWORD was never checked: a user id — which is not a secret, it travels in
// audit rows and admin screens — plus one TOTP code, or one recovery code, was
// a complete credential. 2FA was not a second factor; it was an alternative
// first factor, and a weaker one.
//
// Behavioural: the real /login and /login-verify handlers run against a stub
// DB, and "did a session get issued" is asserted from `user_sessions` and the
// Set-Cookie header, not from the response text.
//
// Every assertion here was proved RED by reintroducing the bug; see
// tests/security-posture-red-proof.mjs.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Hono } from "hono";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* Node 22.6+ strips types natively */
}

const totpLib = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/totp.ts")).href
);
const pwLib = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/password.ts")).href
);
const pending = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/totp-pending.ts")).href
);

const PASSWORD = "correct-horse-battery-staple";
const SECRET = totpLib.generateSecret();

function phIndex(sql, col) {
  const m = new RegExp(`(?:^|[^\\w.])${col}\\s*=\\s*\\?`).exec(sql);
  if (!m) return -1;
  return (sql.slice(0, m.index).match(/\?/g) || []).length;
}

/**
 * Stub DB covering `users`, `user_sessions` and `totp_pending_logins`.
 *
 * `totp_pending_logins` is modelled as a real table — INSERT / SELECT / DELETE
 * all behave — because a stub that answered "row found" to every SELECT would
 * let the gate pass with the token check deleted, which is the exact false
 * all-clear this suite exists to avoid.
 *
 * `strictDdl` demands that the CREATE has run before any read or write. It is
 * OFF by default: the self-apply memo in totp-pending.ts is module-scoped (once
 * per isolate, which is correct in production), so only the FIRST stub in this
 * process ever sees the CREATE. One dedicated test below imports a fresh module
 * instance and turns it on.
 */
function makeDb(users, { strictDdl = false } = {}) {
  const sessions = new Map();
  const pendings = new Map(); // token_hash -> { user_id, expires_at }
  let pendingTableCreated = false;
  const requireTable = (what) => {
    if (strictDdl) {
      assert.ok(pendingTableCreated, `the table self-apply must run before the ${what}`);
    }
  };

  function prepare(sql) {
    let bound = [];
    const s = sql.trim();
    const api = {
      bind(...a) {
        bound = a;
        return api;
      },
      async first() {
        if (/FROM users/i.test(s)) {
          if (/LOWER\(email\)/i.test(s)) {
            const t = String(bound[0] || "").toLowerCase();
            return users.find((u) => u.email.toLowerCase() === t) ?? null;
          }
          const i = phIndex(s, "id");
          return users.find((u) => u.id === bound[i]) ?? null;
        }
        if (/FROM totp_pending_logins/i.test(s)) {
          requireTable("read");
          const i = phIndex(s, "token_hash");
          const row = pendings.get(bound[i]);
          return row ? { ...row } : null;
        }
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        if (/CREATE TABLE IF NOT EXISTS totp_pending_logins/i.test(s)) {
          pendingTableCreated = true;
          return { success: true };
        }
        if (/INSERT INTO totp_pending_logins/i.test(s)) {
          requireTable("write");
          const [token_hash, user_id, created_at, expires_at] = bound;
          pendings.set(token_hash, { token_hash, user_id, created_at, expires_at });
          return { success: true };
        }
        if (/DELETE FROM totp_pending_logins/i.test(s)) {
          const i = phIndex(s, "user_id");
          for (const [k, v] of [...pendings]) {
            if (v.user_id === bound[i]) pendings.delete(k);
          }
          return { success: true };
        }
        if (/INSERT INTO user_sessions/i.test(s)) {
          const [token, userId] = bound;
          sessions.set(token, { token, userId });
          return { success: true };
        }
        return { success: true };
      },
    };
    return api;
  }

  const db = {
    prepare,
    async batch(stmts) {
      for (const st of stmts) await st.run();
      return [];
    },
  };
  return { db, sessions, pendings };
}

function wrap(routeApp) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", c.env?.DB);
    await next();
  });
  parent.route("/", routeApp);
  return parent;
}

async function loadTotpRoute() {
  const mod = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/routes/auth-totp.ts")).href +
      `?t=${Math.random()}`
  );
  return wrap(mod.default);
}

async function makeUser() {
  return {
    id: "user-1",
    email: "owner@hookka.example",
    passwordHash: await pwLib.hashPassword(PASSWORD),
    role: "SUPER_ADMIN",
    isActive: 1,
    displayName: "Owner",
    totpSecret: SECRET,
    totpEnrolledAt: "2026-08-01T00:00:00.000Z",
    totpRecoveryHashes: JSON.stringify([
      await totpLib.hashRecoveryCode("user-1", "RECOVERY-CODE-1"),
    ]),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** The 6-digit code an authenticator app would show right now. */
async function currentCode() {
  const { hotp, base32Decode } = totpLib._internals;
  const step = Math.floor(Date.now() / 1000 / 30);
  return hotp(base32Decode(SECRET), step, 6);
}

function post(app, db, body) {
  return app.request(
    "/login-verify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    { DB: db },
  );
}

// ---- the hole --------------------------------------------------------------

test("login-verify with a VALID recovery code but NO pending token issues no session", async () => {
  const { db, sessions } = makeDb([await makeUser()]);
  const app = await loadTotpRoute();
  const res = await post(app, db, { userId: "user-1", code: "RECOVERY-CODE-1" });

  assert.equal(res.status, 401, "possession of a recovery code is not a login");
  assert.equal(sessions.size, 0, "no session row may be written");
  assert.equal(res.headers.get("set-cookie"), null, "no auth cookie may be set");
});

test("a recovery code refused for want of a pending token is NOT burned", async () => {
  // Otherwise an attacker with a stolen code could still cost the real user
  // their one-shot recovery codes, one refused request at a time.
  const user = await makeUser();
  const { db } = makeDb([user]);
  const app = await loadTotpRoute();
  await post(app, db, { userId: "user-1", code: "RECOVERY-CODE-1" });
  assert.equal(
    JSON.parse(user.totpRecoveryHashes).length,
    1,
    "the recovery hash list must be untouched",
  );
});

test("a pending token minted for ANOTHER user does not unlock this one", async () => {
  const { db, sessions } = makeDb([await makeUser()]);
  const token = await pending.issuePendingTotpToken(db, "someone-else");
  const app = await loadTotpRoute();
  const res = await post(app, db, {
    userId: "user-1",
    code: "RECOVERY-CODE-1",
    pendingToken: token,
  });
  assert.equal(res.status, 401);
  assert.equal(sessions.size, 0);
});

test("an EXPIRED pending token is refused, with a message that says what to do", async () => {
  const { db, sessions } = makeDb([await makeUser()]);
  const token = await pending.issuePendingTotpToken(
    db,
    "user-1",
    Date.now() - pending.PENDING_TOTP_TTL_MS - 1000,
  );
  const app = await loadTotpRoute();
  const res = await post(app, db, {
    userId: "user-1",
    code: "RECOVERY-CODE-1",
    pendingToken: token,
  });
  assert.equal(res.status, 401);
  assert.equal(sessions.size, 0);
  assert.match((await res.json()).error, /password again/i);
});

test("a made-up pending token is refused", async () => {
  const { db, sessions } = makeDb([await makeUser()]);
  const app = await loadTotpRoute();
  const res = await post(app, db, {
    userId: "user-1",
    code: "RECOVERY-CODE-1",
    pendingToken: "deadbeef".repeat(8),
  });
  assert.equal(res.status, 401);
  assert.equal(sessions.size, 0);
});

// ---- the legitimate flow still works ---------------------------------------

test("password → pending token → recovery code issues exactly one session", async () => {
  const user = await makeUser();
  const { db, sessions, pendings } = makeDb([user]);
  const token = await pending.issuePendingTotpToken(db, "user-1");
  assert.equal(pendings.size, 1);

  const app = await loadTotpRoute();
  const res = await post(app, db, {
    userId: "user-1",
    code: "RECOVERY-CODE-1",
    pendingToken: token,
  });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  const json = JSON.parse(raw);
  assert.equal(json.success, true);
  assert.equal(json.data.user.id, "user-1");
  assert.equal(sessions.size, 1, "the enrolled user must still be able to sign in");
  assert.ok(res.headers.get("set-cookie"), "auth cookies must still be set");

  // Single-use: the token is burned, so a replay cannot mint a second session.
  assert.equal(pendings.size, 0, "the pending token must be burned");
  const replay = await post(app, db, {
    userId: "user-1",
    code: "RECOVERY-CODE-1",
    pendingToken: token,
  });
  assert.equal(replay.status, 401, "a burned token must not work twice");
  assert.equal(sessions.size, 1, "and no second session may appear");
});

test("a WRONG code does not cost the operator their password step", async () => {
  // A gate that punishes a typo by demanding the password again is a gate that
  // gets switched off. The 10-per-15-minutes throttle bounds the retries.
  const { db, sessions, pendings } = makeDb([await makeUser()]);
  const token = await pending.issuePendingTotpToken(db, "user-1");
  const app = await loadTotpRoute();

  const wrong = await post(app, db, {
    userId: "user-1",
    code: "000000",
    pendingToken: token,
  });
  assert.equal(wrong.status, 401);
  assert.equal(sessions.size, 0);
  assert.equal(pendings.size, 1, "the pending token survives a wrong code");

  const retry = await post(app, db, {
    userId: "user-1",
    code: "RECOVERY-CODE-1",
    pendingToken: token,
  });
  assert.equal(retry.status, 200, "the retry must succeed on the same token");
  assert.equal(sessions.size, 1);
});

test("a real 6-digit TOTP code works through the same gate", async () => {
  const code = await currentCode();
  assert.match(code, /^\d{6}$/, "the generator must produce a real code, not nothing");

  // Without the pending token — the actual attack — it must fail.
  {
    const { db, sessions } = makeDb([await makeUser()]);
    const app = await loadTotpRoute();
    const res = await post(app, db, { userId: "user-1", code });
    assert.equal(res.status, 401, "a valid TOTP code alone is not a login");
    assert.equal(sessions.size, 0);
  }
  // With it, the enrolled user signs in as before.
  {
    const { db, sessions } = makeDb([await makeUser()]);
    const token = await pending.issuePendingTotpToken(db, "user-1");
    const app = await loadTotpRoute();
    const res = await post(app, db, { userId: "user-1", code, pendingToken: token });
    assert.equal(res.status, 200, await res.text());
    assert.equal(sessions.size, 1);
  }
});

// ---- the token itself ------------------------------------------------------

test("the pending token is stored HASHED, never in the clear", async () => {
  const { db, pendings } = makeDb([await makeUser()]);
  const token = await pending.issuePendingTotpToken(db, "user-1");
  const stored = [...pendings.keys()];
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0], token, "the raw token must not be the stored value");
  assert.equal(stored[0], await pending.hashPendingToken(token));
  assert.match(stored[0], /^[0-9a-f]{64}$/, "SHA-256 hex");
  assert.ok(token.length >= 32, "and the token itself must carry real entropy");
});

test("the table self-applies before the first write (migrations are inert on deploy)", async () => {
  // A FRESH module instance, so its self-apply memo has not already been set by
  // an earlier test in this process — the memo is per-isolate by design.
  const fresh = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/lib/totp-pending.ts")).href +
      `?fresh=${Math.random()}`
  );
  const { db, pendings } = makeDb([await makeUser()], { strictDdl: true });
  const token = await fresh.issuePendingTotpToken(db, "user-1");
  assert.equal(pendings.size, 1);
  assert.equal(
    (await fresh.checkPendingTotpToken(db, "user-1", token)).ok,
    true,
    "and the read side must self-apply too",
  );
});

test("two logins mint two DIFFERENT tokens", async () => {
  const { db } = makeDb([await makeUser()]);
  const a = await pending.issuePendingTotpToken(db, "user-1");
  const b = await pending.issuePendingTotpToken(db, "user-1");
  assert.notEqual(a, b);
});

// ---- /login mints it, and never falls back ---------------------------------

test("/login's 2FA branch mints a pending token and does NOT issue a session", () => {
  const src = readFileSync(new URL("../src/api/routes/auth.ts", import.meta.url), "utf8");
  const start = src.indexOf("if (TOTP_LOGIN_ENFORCEMENT_ENABLED && user.totpEnrolledAt)");
  const end = src.indexOf("Soft 2FA prompt for SUPER_ADMIN. Computed BEFORE", start);
  assert.ok(start > 0 && end > start, "anchors must both be found");
  const body = src.slice(start, end);
  assert.match(body, /issuePendingTotpToken\(c\.var\.DB, user\.id\)/);
  assert.match(body, /pendingToken,/, "the token must actually reach the response");
  assert.ok(
    !/issueSessionCookies|INSERT INTO user_sessions/.test(body),
    "step 1 must still not issue a session — the recorded decision this preserves",
  );
  // A storage failure must be a refusal, not a bypass.
  assert.match(body, /503/);
});

test("login-verify gates on the CALL, not on the identifier merely appearing", () => {
  const src = readFileSync(
    new URL("../src/api/routes/auth-totp.ts", import.meta.url),
    "utf8",
  );
  const handler = src.slice(src.indexOf('app.post("/login-verify"'));
  assert.match(handler, /await checkPendingTotpToken\(c\.var\.DB, userId, pendingToken\)/);
  assert.match(handler, /if \(!pending\.ok\) \{/, "the result must gate a return");
  // The gate must sit BEFORE the code is verified, or a refused request still
  // burns a recovery code.
  assert.ok(
    handler.indexOf("checkPendingTotpToken") < handler.indexOf("verifyRecoveryCode"),
    "the pending check must precede the recovery-code path",
  );
  assert.match(handler, /await consumePendingTotpToken\(c\.var\.DB, userId\)/);
  // The throttle stays.
  assert.match(handler, /checkLoginRateLimit\(c, rlKey\)/);
});
