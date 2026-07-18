# Hookka iOS shell (Capacitor)

Wraps the TWO existing installable web apps as App Store builds:

| App | Loads | Bundle id | Who |
|---|---|---|---|
| Hookka Worker | `https://erp.hookka.com/worker` | `com.hookka.worker` | shop floor — punch, scan job cards, pay |
| Hookka ERP | `https://erp.hookka.com/m` | `com.hookka.erp` | office mobile |

Nothing here changes the web app. There is **no `@capacitor/*` import anywhere in
`src/`** — the app talks to the shell through the runtime `window.Capacitor`
bridge via `src/lib/native/*`, which returns "unavailable" in a browser so every
existing web path stays exactly as it is (additive rule).

---

## Why it loads the live site instead of a bundled copy

The ERP authenticates with **cookies** (session + `hookka_csrf`) scoped to
`erp.hookka.com`. If the shell served a bundled copy of `dist/`, the webview
origin becomes `capacitor://localhost`, every `/api/*` call turns cross-origin,
and the session cookie stops being sent — auth breaks on day one and would need
CORS + `SameSite=None` + a token-auth rewrite on the backend to fix.

Loading the live URL keeps the webview **same-origin with the API**, so login,
CSRF, and every existing call behave identically to Safari today. Zero backend
change, zero auth risk.

Trade-offs accepted for v1, and the exits:
- **Needs connectivity to launch.** Acceptable: both apps are live-data apps —
  a cached shell with no API is not useful anyway. `webDir` ships a small offline
  notice so a dead network shows a branded screen, not a white void.
- **App Store guideline 4.2** ("minimum functionality") rejects thin website
  wrappers. Mitigated by real native capability — barcode scanning, push
  notifications, camera/photo punch selfies, geolocation — not by the wrapper
  itself. If a reviewer still pushes back, the escalation is to bundle the shell
  and move the native app to token auth (a real project, deliberately not v1).
- **Offline punch** is NOT built here. The owner parked that (weak-wifi campaign:
  fix the APs/4G first). When it's unparked, it lands as a native queue in this
  shell.

---

## Layout

```
mobile/
  package.json                 deps live HERE, not in the ERP package.json
  capacitor.worker.config.ts   Worker Portal target
  capacitor.erp.config.ts      Hookka ERP target
  offline/index.html           the branded "no connection" webDir bundle
```

The generated `ios/` project is **not committed** — it is scaffolded in CI on a
macOS runner (`.github/workflows/ios-build.yml`), because it can neither be
generated nor verified from the Windows dev machine. Everything that a human
authored (configs, permission strings, privacy manifest, the native bridge in
`src/lib/native`) IS committed and reviewable.

---

## Building without a Mac

`.github/workflows/ios-build.yml` runs on a GitHub-hosted **macOS** runner:
scaffolds the iOS project, installs pods, and archives an `.ipa`. Run it from
the Actions tab (`workflow_dispatch`) and pick the app.

Signing is intentionally NOT wired here — it needs Apple certificates, which are
credentials. Two options once the Apple Developer account exists:
1. Upload the signing assets as GitHub secrets and add the signing step, or
2. Download the unsigned archive and sign/submit from Xcode / Transporter.

---

## What still needs a human (cannot be automated away)

1. **Apple Developer Program enrolment** ($99/yr). A *company* enrolment needs a
   **D-U-N-S number** and can take days to weeks — this is the long pole, start
   it before the code is finished.
2. **Signing certificates + provisioning profiles.**
3. **App Store Connect**: two app records, screenshots, privacy answers.
4. **A demo account for review.** Both apps are login-gated internal tools;
   Apple WILL reject them if the reviewer can't get in. Provide a working
   worker login and an ERP login in App Review notes.
5. **Privacy nutrition labels** — declare camera, photos, location, and any
   identifiers, matching `PrivacyInfo.xcprivacy`.
