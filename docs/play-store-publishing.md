# Publishing Hookka to Google Play (public listing)

> **Last verified: 2026-08-13** against `public/.well-known/assetlinks.json`,
> `public/privacy.html`, `public/manifest-erp.webmanifest`, `public/manifest.webmanifest`,
> `public/pwa-icon-*.png`, `docs/play-assets/`, `mobile/package.json`,
> `.github/workflows/ios-build.yml`.
>
> **This is NOT a completed one-off — it is an open owner procedure.** Both
> `sha256_cert_fingerprints` in `public/.well-known/assetlinks.json` still read
> `FILL_FROM_PLAY_CONSOLE_APP_SIGNING_SHA256`, so Step 4 has never been done and neither
> TWA has been published. Steps 1–6 are still to do.
>
> Corrected 2026-08-13: the listing-assets claim overstated what is in the repo (no
> screenshots), and `public/privacy` is really `public/privacy.html`.
>
> **Scope note:** this doc covers the *Android / TWA* path only. There is a second,
> unrelated native path — `mobile/` (Capacitor 6 iOS shells for worker + erp) driven by
> `.github/workflows/ios-build.yml`, which is `workflow_dispatch`-only, produces an
> **unsigned** archive, and has no Apple Developer account wired. Neither store has a
> shipped app.
>
> ⚠️ **Security:** the "App access" section below puts a live-format employee number and
> 6-digit PIN in plain text in a repo that `ios-build.yml` describes as PUBLIC. Confirm
> `Test-001` / `123456` is a throwaway reviewer account with no real data access, or move
> these to a Play Console field only and delete them here.

Two apps from the same PWA, wrapped as **TWAs** (Trusted Web Activity):

| App | Install from URL | start_url | Suggested package | Icon |
|---|---|---|---|---|
| **Hookka ERP** (office) | `https://erp.hookka.com` | `/m` | `com.hookka.erp` | black bg / white logo |
| **Hookka Worker** (shop floor) | `https://erp.hookka.com/worker` | `/worker` | `com.hookka.worker` | white bg / black logo |

Cost: **one-time USD $25** Google Play developer account. Publishing free apps after that is free.

## What's already prepared in the repo
- `public/.well-known/assetlinks.json` — Digital Asset Links for both packages (fingerprints are placeholders — fill after Play App Signing, see Step 4).
- `public/privacy.html` — privacy policy, served at `https://erp.hookka.com/privacy` (required for the listing + Data Safety).
- Manifests + icons already TWA-ready (`manifest-erp.webmanifest`, `manifest.webmanifest`, the pwa-icon PNGs).

## Steps (owner — account, payment, submission are yours; I can't do those)

**1. Create a Google Play developer account** — https://play.google.com/console → pay the one-time $25 (use an Organization account in Hookka's name if you can).

**2. Build each Android package with PWABuilder** (no local tools needed):
   - Go to https://www.pwabuilder.com → enter `https://erp.hookka.com` (for ERP) → **Package for stores → Android**.
   - Package ID: `com.hookka.erp`. App name: `Hookka ERP`. Keep "Trusted Web Activity". Download the `.aab` (+ the generated `assetlinks` snippet/signing info).
   - Repeat with `https://erp.hookka.com/worker` → package `com.hookka.worker`, name `Hookka Worker`.

**3. In Play Console, create each app** → upload its `.aab` to a release (start with **Internal testing**, promote to Production after it works).

**4. Wire Digital Asset Links** — in Play Console → your app → **Setup → App integrity → App signing** → copy the **SHA-256 certificate fingerprint**. Paste it into BOTH entries of `public/.well-known/assetlinks.json` (each app uses its own app's fingerprint). Tell me and I'll deploy to prod so `https://erp.hookka.com/.well-known/assetlinks.json` serves the real value → the app then opens full-screen with no browser bar.

**5. Fill the store listing** (copy below) → set **Privacy policy URL** = `https://erp.hookka.com/privacy` → complete **Data safety**, **Content rating** (Everyone / business), **Target audience** (adults).

**6. Submit for review** (first review can take a few days).

> ⚠️ Data Safety form — declare honestly: collects **Email** (account), **Photos** (worker punch selfie), **Approximate location** (worker geofence, used in-app only, not shared/tracked), and **App activity** (work records). Encrypted in transit; users can request deletion via the contact email. Camera + location are only the Worker app.

---

## Store listing copy

### Hookka ERP (office)
- **Short description (≤80):** Manufacturing ERP for Hookka staff — sales, production, delivery, stock.
- **Full description:** Hookka ERP is the mobile companion to Hookka Industries' manufacturing platform. Authorised staff can review the dashboard (sales, invoices, pending deliveries, outstanding), open and create sales / delivery / purchase orders, track production, check inventory and warehouse stock, view payslips, and read announcements and mail — all from the phone. A valid Hookka account is required; this is an internal business tool.
- **Category:** Business.

### Hookka Worker (shop floor)
- **Short description (≤80):** Clock in, scan job cards and view pay — for Hookka shop-floor workers.
- **Full description:** The Hookka Worker Portal lets shop-floor workers clock in and out (with a quick punch photo), scan job-card QR/barcodes to record production, view their attendance and payslips, and see team announcements. Sign in with your employee number and 6-digit PIN. A valid Hookka worker account is required.
- **Category:** Business.

---

## Alternative (no store, $0, works today)
For an internal tool, "Add to Home Screen" already installs both apps with the correct icons (black for ERP, white for Worker) — no account, no fee, instant. The Play listing only adds public discoverability. Keep that in mind before paying the $25.

---

## Ready-to-fill Console values (copy these in)

**Pricing:** the $25 is a **one-time developer-account fee** — it covers BOTH apps (and any future ones). Not per-app.

**App access (CRITICAL — login-gated app, reviewer must sign in or it's rejected):**
- Provide these test credentials in Play Console → *App access* → "All or some functionality is restricted":
  - **Username / Employee No:** `Test-001`
  - **Password / PIN:** `123456`
- Note to reviewer: "Internal business tool. Sign in with the test account above. Worker app: enter the employee number + PIN on the keypad."

**Data safety (declare honestly):**
- Data collected: **Email address** (account); **Photos** (worker punch selfie, Worker app only); **Approximate location** (worker geofence, Worker app only — used in-app, not shared, not for tracking); **App activity / other** (work records you enter).
- All: encrypted in transit ✔; users can request deletion (support@hookka.com) ✔; not sold/shared with third parties for ads ✔.

**Content rating:** category **Business / Productivity**; no violence/sexual/gambling content → rating comes out **Everyone**.

**Target audience:** adults (18+) — internal staff tool, not directed at children.

**Privacy policy URL:** `https://erp.hookka.com/privacy`  ·  **Contact:** `support@hookka.com`

**Listing assets prepared** (in `docs/play-assets/`) — **corrected 2026-08-13**, the folder holds exactly three files: `icon-erp-512.png`, `icon-worker-512.png`, `feature-graphic.png`. **The phone screenshots this line used to claim are NOT in the repo** and must still be captured — Play requires at least 2 phone screenshots per app before the listing can be submitted.
