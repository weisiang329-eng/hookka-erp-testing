# Auth wire-up — changes required in `src/api/worker.ts`

I was not allowed to touch `worker.ts` directly. Paste the snippets below into the indicated locations. All snippets match the existing code style (short comments, no blank-line gymnastics).

---

## 1. Add the middleware + route imports (below the existing `import invoices from "./routes/invoices";` line)

Current file ends its import block at:

```ts
import invoices from "./routes/invoices";
import payments from "./routes/payments";
```

Add these three lines **after** `import payments`:

```ts
import auth from "./routes/auth";
import users from "./routes/users";
import { authMiddleware } from "./lib/auth-middleware";
```

---

## 2. Install the auth middleware — BEFORE any route registrations

Right after the `app.get("/api/health", ...)` block (line ~51) and BEFORE the `// Route registrations` comment (line ~53), insert:

```ts
// Global auth gate for /api/* — skips PUBLIC_PATHS (login/logout/health).
app.use("/api/*", authMiddleware);
```

> The middleware itself short-circuits `/api/auth/login`, `/api/auth/logout`, and `/api/health`, so the health endpoint and login flow keep working.

---

## 3. Register the two new routes — alongside the existing `app.route(...)` calls

Add these two lines anywhere inside the existing `app.route("/api/...", ...);` block (e.g. right after `app.route("/api/payments", payments);`):

```ts
app.route("/api/auth", auth);
app.route("/api/users", users);
```

---

## Final shape (for reference)

Your route-registrations block should now end with something like:

```ts
app.route("/api/invoices", invoices);
app.route("/api/payments", payments);
app.route("/api/auth", auth);
app.route("/api/users", users);
```

And the middleware/health section should read:

```ts
app.get("/api/health", (c) =>
  c.json({ ok: true, runtime: "cloudflare-workers", env: c.env.ENVIRONMENT, ts: Date.now() }),
);

// Global auth gate for /api/* — skips PUBLIC_PATHS (login/logout/health).
app.use("/api/*", authMiddleware);

// ---------------------------------------------------------------------------
// Route registrations — add each migrated route here.
// ---------------------------------------------------------------------------
```

That's it. No other changes to `worker.ts` are needed.
